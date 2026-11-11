// @ghuri/orm/testing — fresh databases for tests on SQLite, PGlite (PostgreSQL) or D1 (Miniflare).
import { apps, createContext, type GhuriContext, setGlobalContext, tryGetContext } from '@ghuri/core'
import './models/relations'
import './drizzle'
import { connections, DEFAULT_DB_ALIAS } from './db/connections'
import { D1Connection, type D1DatabaseLike } from './db/d1'
import type { Connection, DatabaseConfig } from './db/types'
import { ForeignKey } from './fields/related'
import { schemaEditorFor } from './migrations/schema/index'
import { isAbstractModel, registerModels } from './models/base'
import { isModelClass, modelRegistry } from './models/registry'
import type { ModelClass } from './models/types'
import { globalSingleton } from './utils'

export type TestBackend = 'sqlite' | 'pglite' | 'd1'

export interface SetupTestDatabaseOptions {
  using?: TestBackend
  /** Models to create tables for (default: every registered model). */
  models?: ModelClass[] | Record<string, unknown>
  /** App label for models that don't have one yet (default 'tests'). */
  appLabel?: string
  /** Connection alias (default 'default'). */
  alias?: string
  /** Create tables (default true). */
  createTables?: boolean
}

export interface TestDatabase {
  alias: string
  using: TestBackend
  connection: Connection
  models: ModelClass[]
  /** Delete every row and reset auto-increment sequences. */
  flush(): Promise<void>
  /** Close the database and restore the previous context / settings. */
  teardown(): Promise<void>
}

/**
 * Creates the schema of a fresh test database. The migrations module can replace this
 * (`setTestSchemaCreator`) to run migrations when present instead of creating tables from models.
 */
export type TestSchemaCreator = (connection: Connection, models: ModelClass[]) => Promise<void>

const schemaCreator = globalSingleton<{ fn?: TestSchemaCreator }>('ghuri.orm.testSchemaCreator', () => ({}))

/** Replace how test databases get their schema (default: `migrateOrCreateTables`). */
export function setTestSchemaCreator(fn: TestSchemaCreator | undefined): void {
  schemaCreator.fn = fn
}

/**
 * Default test schema creator: runs the migrations of installed apps that have some (like Django's test
 * runner) and creates tables directly from models for everything else.
 */
export async function migrateOrCreateTables(connection: Connection, models: ModelClass[]): Promise<void> {
  const { MigrationLoader } = await import('./migrations/loader')
  const loader = await MigrationLoader.load({ connection: null })
  const withMigrations = new Set([...loader.migrations.values()].map((m) => m.appLabel))
  if (!withMigrations.size) return createTablesForModels(connection, models)
  const { migrate } = await import('./migrations/api')
  const editor = schemaEditorFor(connection)
  for (const m of models) {
    if (!m._meta.managed || m._meta.autoCreated || withMigrations.has(m._meta.appLabel)) continue
    await editor.createModel(m)
  }
  await migrate({ connection, using: connection.alias })
  await editor.flushDeferred()
}

/** CREATE TABLE (+ indexes, M2M tables, foreign keys) for `models` on `connection`. */
export async function createTablesForModels(connection: Connection, models: ModelClass[]): Promise<void> {
  const editor = schemaEditorFor(connection)
  await editor.run(async (e) => {
    for (const m of models) if (m._meta.managed && !m._meta.autoCreated) await e.createModel(m)
  })
}

async function openConnection(
  using: TestBackend,
): Promise<{ conn: Connection; dispose?: () => Promise<void> }> {
  if (using === 'sqlite') {
    const { openSqlite } = await import('./sqlite')
    return { conn: openSqlite({ filename: ':memory:' }) }
  }
  if (using === 'pglite') {
    const { openPGlite } = await import('./pglite')
    return { conn: await openPGlite() }
  }
  const { Miniflare } = await import('miniflare')
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null, { status: 204 }) } }',
    d1Databases: { DB: `ghuri-test-${crypto.randomUUID()}` },
  })
  const db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike
  return { conn: new D1Connection(db), dispose: () => mf.dispose() }
}

function collectModels(opts: SetupTestDatabaseOptions): ModelClass[] {
  const label = opts.appLabel ?? 'tests'
  if (opts.models) {
    const list = (Array.isArray(opts.models) ? opts.models : Object.values(opts.models)).filter(
      (m): m is ModelClass => isModelClass(m) && !isAbstractModel(m),
    )
    const unlabeled = list.filter((m) => !m._meta.hasAppLabel)
    if (unlabeled.length) registerModels(label, unlabeled)
    for (const m of list) if (m._meta.hasAppLabel) modelRegistry.register(m._meta.appLabel, m)
    return list
  }
  const all = new Set<ModelClass>()
  for (const m of apps.getModels()) if (isModelClass(m)) all.add(m)
  for (const m of modelRegistry.all)
    if (m._meta.hasAppLabel && !m._meta.autoCreated && !m._meta.abstract) all.add(m)
  return [...all]
}

/** Every table of `models` incl. auto-created M2M tables, ordered so referencing tables come first. */
function tablesInDeleteOrder(models: ModelClass[]): ModelClass[] {
  const set = new Set<ModelClass>()
  for (const m of models) {
    set.add(m)
    for (const f of m._meta.localManyToMany) if (f.throughModel) set.add(f.throughModel)
  }
  const out: ModelClass[] = []
  const done = new Set<ModelClass>()
  const visiting = new Set<ModelClass>()
  const visit = (m: ModelClass) => {
    if (done.has(m) || visiting.has(m)) return
    visiting.add(m)
    // models referencing m must be emptied before m
    for (const other of set) {
      if (other === m) continue
      if (other._meta.concreteFields.some((f) => f instanceof ForeignKey && f.relatedModel === m))
        visit(other)
    }
    visiting.delete(m)
    done.add(m)
    out.push(m)
  }
  for (const m of set) visit(m)
  return out
}

/**
 * Fresh in-memory database for tests: SQLite (better-sqlite3), PostgreSQL dialect (PGlite) or D1
 * (Miniflare). Installs a global context with `DATABASES[alias]` (or merges into the current context),
 * creates tables for the models and returns `{ connection, flush, teardown }`.
 */
export async function setupTestDatabase(opts: SetupTestDatabaseOptions = {}): Promise<TestDatabase> {
  const using = opts.using ?? 'sqlite'
  const alias = opts.alias ?? DEFAULT_DB_ALIAS
  const models = collectModels(opts)
  modelRegistry.resolvePending()
  const { conn, dispose } = await openConnection(using)
  conn.alias = alias
  const config: DatabaseConfig = {
    vendor: conn.vendor,
    dialect: conn.dialect,
    connect: () => conn,
    options: { test: true },
  }

  let ctx: GhuriContext | undefined = tryGetContext()
  let createdContext = false
  const previous = ctx?.settings.DATABASES
  if (ctx) {
    ctx.settings.DATABASES = { ...(ctx.settings.DATABASES ?? {}), [alias]: config }
  } else {
    ctx = createContext({
      env: {},
      settings: {
        SECRET_KEY: 'test-secret-key',
        DEBUG: true,
        INSTALLED_APPS: [],
        ROOT_URLCONF: [],
        DATABASES: { [alias]: config },
      },
    })
    setGlobalContext(ctx)
    createdContext = true
  }
  connections.reset(alias)

  if (opts.createTables !== false) await (schemaCreator.fn ?? migrateOrCreateTables)(conn, models)

  const flush = async () => {
    const ordered = tablesInDeleteOrder(models).filter((m) => m._meta.managed)
    if (conn.dialect === 'postgresql') {
      if (!ordered.length) return
      await conn.execute(
        `TRUNCATE ${ordered.map((m) => `"${m._meta.dbTable}"`).join(', ')} RESTART IDENTITY CASCADE`,
      )
      return
    }
    for (const m of ordered) await conn.execute(`DELETE FROM "${m._meta.dbTable}"`)
    try {
      await conn.execute('DELETE FROM sqlite_sequence')
    } catch {}
  }

  const teardown = async () => {
    connections.reset(alias)
    await conn.close()
    await dispose?.()
    if (createdContext) {
      if (tryGetContext() === ctx) setGlobalContext(undefined)
    } else if (ctx) {
      if (previous === undefined) delete ctx.settings.DATABASES
      else ctx.settings.DATABASES = previous
    }
  }

  return { alias, using, connection: conn, models, flush, teardown }
}

/** Backends available for `describe.each` (all three by default; `GHURI_TEST_BACKENDS=sqlite,pglite`). */
export function testBackends(): TestBackend[] {
  const env = typeof process !== 'undefined' ? process.env.GHURI_TEST_BACKENDS : undefined
  const all: TestBackend[] = ['sqlite', 'pglite', 'd1']
  if (!env) return all
  return env
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is TestBackend => (all as string[]).includes(s))
}
