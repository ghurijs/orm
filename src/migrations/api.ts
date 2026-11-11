import { type AppConfig, apps, type CommandIO } from '@ghuri/core'
import { connections, DEFAULT_DB_ALIAS } from '../db/connections'
import type { Connection } from '../db/types'
import { isModelClass } from '../models/registry'
import type { ModelClass } from '../models/types'
import { type Dialect, literal } from '../query/sql'
import { postMigrate, preMigrate } from '../signals'
import { globalSingleton } from '../utils'
import { MigrationAutodetector, type MigrationQuestioner, NonInteractiveQuestioner } from './autodetector'
import { MigrationConflictError, NodeNotFoundError } from './errors'
import { MigrationExecutor, type MigrationPlanEntry, type ProgressEvent } from './executor'
import { keyOf } from './graph'
import { MigrationLoader } from './loader'
import { Migration, type MigrationKey } from './migration'
import type { SchemaContext } from './operations'
import { InteractiveQuestioner } from './questioner'
import { MigrationRecorder } from './recorder'
import { schemaEditorFor } from './schema/index'
import { ProjectState } from './state'
import { MigrationWriter, migrationsIndexSource } from './writer'

// ---- file system hook (installed by @ghuri/orm/commands in Node) ----------------------------------

/** File access used by makemigrations / sqlmigrate --out; installed by `@ghuri/orm/commands`. */
export interface MigrationFileSystem {
  writeFile(path: string, content: string): Promise<void>
  readFile(path: string): Promise<string>
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  join(...parts: string[]): string
  /** Path relative to the working directory, for messages. */
  relative(path: string): string
}

const fsHook = globalSingleton<{ fs?: MigrationFileSystem }>('ghuri.orm.migrations.fs', () => ({}))

export function setMigrationFileSystem(fs: MigrationFileSystem | undefined): void {
  fsHook.fs = fs
}

export function getMigrationFileSystem(): MigrationFileSystem {
  if (!fsHook.fs)
    throw new Error(
      'Writing migration files needs Node: import @ghuri/orm/commands (or call setMigrationFileSystem).',
    )
  return fsHook.fs
}

/** Migration file names (without extension) in a migrations directory. */
export const MIGRATION_FILE = /^(\d{4}_[A-Za-z0-9_]+)\.(ts|mts|js|mjs)$/

function out(io: CommandIO | undefined, msg: string): void {
  io?.stdout(msg)
}

// ---- makemigrations ------------------------------------------------------------------------------

export interface MakeMigrationsOptions {
  /** Limit to these apps (also creates initial migrations for apps without migrations). */
  appLabels?: string[]
  /** Name after the number (`--name`). */
  name?: string
  /** Create empty migrations for `appLabels` (`--empty`). */
  empty?: boolean
  /** Show what would be generated without writing (`--dry-run`). */
  dryRun?: boolean
  /** Exit non-zero (result.exitCode 1) when changes are missing migrations; never writes (`--check`). */
  check?: boolean
  /** Create merge migrations for conflicting leaves (`--merge`). */
  merge?: boolean
  /** Ask questions through `io` (default: true when `io.prompt` exists). */
  interactive?: boolean
  io?: CommandIO
  questioner?: MigrationQuestioner
  /** Write files (default: not dryRun / check). */
  write?: boolean
}

export interface GeneratedMigration {
  app: string
  name: string
  migration: Migration
  source: string
  /** Where it was (or would be) written. */
  path?: string
}

export interface MakeMigrationsResult {
  migrations: GeneratedMigration[]
  /** 1 for `check` with pending changes, else 0. */
  exitCode: number
  warnings: string[]
}

function migrationsDir(config: AppConfig): string | null {
  if (!config.path) return null
  return fsHook.fs ? fsHook.fs.join(config.path, 'migrations') : `${config.path}/migrations`
}

async function writeMigrationFiles(generated: GeneratedMigration[], io?: CommandIO): Promise<void> {
  const fs = getMigrationFileSystem()
  const touched = new Set<string>()
  for (const g of generated) {
    const config = apps.getAppConfig(g.app)
    const dir = migrationsDir(config)
    if (!dir)
      throw new Error(
        `AppConfig '${g.app}' has no path; set \`path = import.meta.dirname\` in its AppConfig to write migrations.`,
      )
    await fs.mkdir(dir)
    const file = fs.join(dir, `${g.name}.ts`)
    await fs.writeFile(file, g.source)
    g.path = file
    touched.add(dir)
  }
  for (const dir of touched) {
    const names = (await fs.readdir(dir))
      .map((f) => f.match(MIGRATION_FILE)?.[1])
      .filter((n): n is string => !!n && !n.endsWith('.d'))
    await fs.writeFile(fs.join(dir, 'index.ts'), migrationsIndexSource([...new Set(names)]))
  }
  void io
}

function liveModelsMap(): Map<string, ModelClass> {
  const map = new Map<string, ModelClass>()
  for (const m of apps.getModels() as unknown[])
    if (isModelClass(m)) map.set(ProjectState.key(m._meta.appLabel, m._meta.objectName), m)
  return map
}

function nextNumber(loader: MigrationLoader, app: string): number {
  let next = 1
  for (const m of loader.graph.nodes.values()) {
    if (m.appLabel !== app) continue
    const n = Number.parseInt(m.name.split('_')[0], 10)
    if (!Number.isNaN(n)) next = Math.max(next, n + 1)
  }
  return next
}

/**
 * Detect model changes and write migrations (Django's `makemigrations`). Pure detection works anywhere;
 * writing needs the Node file system hook (`@ghuri/orm/commands`).
 */
export async function makeMigrations(opts: MakeMigrationsOptions = {}): Promise<MakeMigrationsResult> {
  const io = opts.io
  const labels = opts.appLabels ?? []
  for (const l of labels)
    if (!apps.isInstalled(l))
      throw new NodeNotFoundError(`App '${l}' could not be found. Is it in INSTALLED_APPS?`)
  const interactive = opts.interactive ?? Boolean(io?.prompt)
  const nonInteractive = new NonInteractiveQuestioner()
  const questioner = opts.questioner ?? (interactive && io ? new InteractiveQuestioner(io) : nonInteractive)
  const write = opts.write ?? (!opts.dryRun && !opts.check)
  const loader = await MigrationLoader.load({ connection: null })
  const conflicts = loader.detectConflicts()
  const conflictApps = Object.keys(conflicts).filter((a) => !labels.length || labels.includes(a))
  const generated: GeneratedMigration[] = []
  const detectorWarnings: string[] = []
  const render = (m: Migration) => new MigrationWriter(m).asString()

  if (opts.merge) {
    if (!conflictApps.length) {
      out(io, 'No conflicts detected to merge.')
      return { migrations: [], exitCode: 0, warnings: [] }
    }
    for (const app of conflictApps) {
      const leaves = conflicts[app]
      if (questioner.askMerge && !(await questioner.askMerge(app, leaves))) continue
      const m = new Migration({ dependencies: leaves.map((n) => [app, n] as const) })
      m.appLabel = app
      const num = String(nextNumber(loader, app)).padStart(4, '0')
      let suffix = opts.name ?? `merge_${leaves.join('_')}`
      if (suffix.length > 52) suffix = `merge_${leaves.map((n) => n.split('_')[0]).join('_')}`
      m.name = `${num}_${suffix}`
      generated.push({ app, name: m.name, migration: m, source: render(m) })
    }
  } else if (conflictApps.length) {
    const desc = conflictApps.map((a) => `${conflicts[a].join(', ')} in ${a}`).join('; ')
    throw new MigrationConflictError(
      `Conflicting migrations detected; multiple leaf nodes in the migration graph: (${desc}). ` +
        'To fix them run `ghuri makemigrations --merge`.',
    )
  } else if (opts.empty) {
    if (!labels.length) throw new Error('You must supply at least one app label when using --empty.')
    for (const app of labels) {
      const leaves = loader.graph.leafNodes(app)
      const m = new Migration({ dependencies: leaves.map((l) => [l[0], l[1]] as const) })
      m.appLabel = app
      if (!leaves.length) m.initial = true
      const num = String(nextNumber(loader, app)).padStart(4, '0')
      m.name = `${num}_${opts.name ?? m.suggestName()}`
      generated.push({ app, name: m.name, migration: m, source: render(m) })
    }
  } else {
    const fromState = loader.projectState()
    const toState = ProjectState.fromApps(apps.getAppConfigs().map((c) => c.appLabel))
    const detector = new MigrationAutodetector(fromState, toState, questioner, liveModelsMap())
    const changes = await detector.changes(loader.graph, {
      trimToApps: labels.length ? labels : undefined,
      convertApps: labels,
      migrationName: opts.name,
    })
    detectorWarnings.push(...detector.warnings)
    for (const [app, list] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
      for (const m of list) generated.push({ app, name: m.name, migration: m, source: render(m) })
    }
  }

  const warnings = [
    ...(questioner instanceof NonInteractiveQuestioner ? questioner.warnings : []),
    ...detectorWarnings,
  ]
  for (const w of warnings) io?.stderr(io.style.warning(w))

  if (!generated.length) {
    if (!opts.merge)
      out(io, labels.length === 1 ? `No changes detected in app '${labels[0]}'` : 'No changes detected')
    return { migrations: [], exitCode: 0, warnings }
  }

  if (write) await writeMigrationFiles(generated, io)
  else {
    for (const g of generated) {
      const dir = migrationsDir(apps.getAppConfig(g.app))
      if (dir) g.path = fsHook.fs ? fsHook.fs.join(dir, `${g.name}.ts`) : `${dir}/${g.name}.ts`
    }
  }

  const byApp = new Map<string, GeneratedMigration[]>()
  for (const g of generated) byApp.set(g.app, [...(byApp.get(g.app) ?? []), g])
  for (const [app, list] of byApp) {
    out(io, io ? io.style.notice(`Migrations for '${app}':`) : `Migrations for '${app}':`)
    for (const g of list) {
      const shown = g.path ? (fsHook.fs ? fsHook.fs.relative(g.path) : g.path) : g.name
      out(io, `  ${io ? io.style.bold(shown) : shown}`)
      for (const op of g.migration.operations) out(io, `    - ${op.describe()}`)
      if (!g.migration.operations.length && opts.merge)
        out(io, `    - Merge ${g.migration.dependencies.map((d) => d[1]).join(', ')}`)
    }
  }
  return { migrations: generated, exitCode: opts.check ? 1 : 0, warnings }
}

// ---- migrate ------------------------------------------------------------------------------------

export interface MigrateOptions {
  /** Migrate only this app (to its latest migration or `target`). */
  appLabel?: string
  /** Migration name (prefix) or `'zero'`. Needs `appLabel`. */
  target?: string
  /** Database alias (`--database`). */
  using?: string
  /** Use this connection instead of `connections.get(using)`. */
  connection?: Connection
  fake?: boolean
  fakeInitial?: boolean
  /** Only show the plan (`--plan`). */
  plan?: boolean
  /** Create tables for apps without migrations (`--run-syncdb`). */
  runSyncdb?: boolean
  /** Don't send preMigrate / postMigrate. */
  skipSignals?: boolean
  io?: CommandIO
}

export interface MigrateResult {
  plan: MigrationPlanEntry[]
  /** False when only showing the plan. */
  executed: boolean
}

function describePlanEntry(entry: MigrationPlanEntry): string[] {
  const lines = [`${entry.migration.appLabel}.${entry.migration.name}${entry.backwards ? ' (unapply)' : ''}`]
  const ops = entry.backwards ? [...entry.migration.operations].reverse() : entry.migration.operations
  for (const op of ops) {
    const irreversible = entry.backwards && !op.reversible
    lines.push(`    ${irreversible ? 'IRREVERSIBLE: ' : ''}${op.describe()}`)
  }
  return lines
}

/** Apply / unapply migrations on a database (Django's `migrate`). */
export async function migrate(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const io = opts.io
  const using = opts.using ?? opts.connection?.alias ?? DEFAULT_DB_ALIAS
  const connection = opts.connection ?? (await connections.get(using))
  const executor = await MigrationExecutor.create({ connection, using })
  const conflicts = executor.loader.detectConflicts()
  if (Object.keys(conflicts).length) {
    const desc = Object.entries(conflicts)
      .map(([a, n]) => `${n.join(', ')} in ${a}`)
      .join('; ')
    throw new MigrationConflictError(
      `Conflicting migrations detected; multiple leaf nodes in the migration graph: (${desc}). ` +
        'To fix them run `ghuri makemigrations --merge`.',
    )
  }
  if (opts.target !== undefined && !opts.appLabel) throw new Error('A migration target needs an app label.')
  const targets = executor.targetsFor(opts.appLabel, opts.target)
  const plan = executor.migrationPlan(targets)

  if (opts.plan) {
    out(io, io ? io.style.notice('Planned operations:') : 'Planned operations:')
    if (!plan.length) out(io, '  No planned migration operations.')
    for (const e of plan) for (const l of describePlanEntry(e)) out(io, l)
    return { plan, executed: false }
  }

  const appConfigs = apps.getAppConfigs()
  out(io, io ? io.style.notice('Operations to perform:') : 'Operations to perform:')
  if (opts.runSyncdb && executor.loader.unmigratedApps.size)
    out(io, `  Synchronize unmigrated apps: ${[...executor.loader.unmigratedApps].sort().join(', ')}`)
  if (opts.target !== undefined) {
    out(
      io,
      opts.target === 'zero'
        ? `  Unapply all migrations: ${opts.appLabel}`
        : `  Target specific migration: ${targets[0][1]}, from ${opts.appLabel}`,
    )
  } else {
    const labels = opts.appLabel ? [opts.appLabel] : [...executor.loader.migratedApps].sort()
    out(io, `  Apply all migrations: ${labels.length ? labels.join(', ') : '(none)'}`)
  }

  if (!opts.skipSignals)
    for (const appConfig of appConfigs) await preMigrate.send(appConfig, { appConfig, using, plan })

  if (opts.runSyncdb) {
    const models = executor.loader.unmigratedModels().filter((m) => m._meta.managed && !m._meta.autoCreated)
    if (models.length) {
      out(
        io,
        io
          ? io.style.notice('Synchronizing apps without migrations:')
          : 'Synchronizing apps without migrations:',
      )
      const editor = schemaEditorFor(connection)
      const existing = new Set(await editor.tableNames())
      await editor.run(async (e) => {
        for (const m of models) {
          if (existing.has(m._meta.dbTable)) continue
          out(io, `  Creating table ${m._meta.dbTable}`)
          await e.createModel(m)
        }
      })
    }
  }

  out(io, io ? io.style.notice('Running migrations:') : 'Running migrations:')
  if (!plan.length) out(io, '  No migrations to apply.')
  const progress = (e: ProgressEvent) => {
    if (!io) return
    const label = `${e.migration.appLabel}.${e.migration.name}`
    if (e.action === 'apply_start') io.stdout(`  Applying ${label}...`)
    else if (e.action === 'unapply_start') io.stdout(`  Unapplying ${label}...`)
    else {
      const suffix = e.fake ? ('fakedInitial' in e && e.fakedInitial ? ' FAKED (initial)' : ' FAKED') : ' OK'
      io.stdout(io.style.success(`  ${label}${suffix}`))
    }
  }
  await executor.migrate(targets, { plan, fake: opts.fake, fakeInitial: opts.fakeInitial, progress })

  if (!opts.skipSignals)
    for (const appConfig of appConfigs) await postMigrate.send(appConfig, { appConfig, using, plan })
  return { plan, executed: true }
}

// ---- showmigrations -----------------------------------------------------------------------------

export interface ShowMigrationsOptions {
  appLabels?: string[]
  using?: string
  connection?: Connection
  /** List in plan order with dependencies instead of per app (`--plan`). */
  plan?: boolean
  io?: CommandIO
}

export interface MigrationStatus {
  app: string
  name: string
  applied: boolean
  /** Names this squashed migration replaces. */
  replaces?: string[]
  dependencies: string[]
}

/** Applied / unapplied migrations per app (Django's `showmigrations`). */
export async function showMigrations(opts: ShowMigrationsOptions = {}): Promise<MigrationStatus[]> {
  const io = opts.io
  const using = opts.using ?? opts.connection?.alias ?? DEFAULT_DB_ALIAS
  const connection = opts.connection ?? (await connections.get(using))
  const loader = await MigrationLoader.load({ connection })
  const graph = loader.graph
  const labels = opts.appLabels?.length ? opts.appLabels : apps.getAppConfigs().map((c) => c.appLabel)
  for (const l of labels)
    if (!apps.isInstalled(l)) throw new NodeNotFoundError(`No installed app with label '${l}'.`)
  const status = (k: MigrationKey): MigrationStatus => {
    const m = graph.get(k)
    const replaced = loader.replacements.get(keyOf(k))
    return {
      app: k[0],
      name: k[1],
      applied: loader.applied.has(keyOf(k)),
      replaces: replaced?.map((r) => r[1]),
      dependencies: [...(graph.parents.get(keyOf(k)) ?? [])].sort(),
      ...(m ? {} : {}),
    }
  }
  const result: MigrationStatus[] = []
  if (opts.plan) {
    for (const k of graph.fullPlan()) {
      if (!labels.includes(k[0])) continue
      const s = status(k)
      result.push(s)
      const deps = s.dependencies.length ? ` ... (${s.dependencies.join(', ')})` : ''
      out(io, `[${s.applied ? 'X' : ' '}]  ${k[0]}.${k[1]}${deps}`)
    }
    return result
  }
  for (const app of [...labels].sort()) {
    out(io, io ? io.style.bold(app) : app)
    const keys = graph.fullPlan().filter((k) => k[0] === app)
    if (!keys.length) {
      out(io, loader.migratedApps.has(app) ? ' (no migrations)' : ' (no migrations)')
      continue
    }
    for (const k of keys) {
      const s = status(k)
      result.push(s)
      const squashed = s.replaces?.length ? ` (${s.replaces.length} squashed migrations)` : ''
      out(io, ` [${s.applied ? 'X' : ' '}] ${k[1]}${squashed}`)
    }
  }
  return result
}

// ---- sqlmigrate ---------------------------------------------------------------------------------

export interface SqlMigrateOptions {
  dialect?: Dialect
  backwards?: boolean
  /** Alias whose dialect is used when `dialect` isn't given. */
  using?: string
  /** Include `BEGIN;`/`COMMIT;` around atomic migrations on PostgreSQL (default true). */
  transaction?: boolean
}

async function collectMigrationSql(
  loader: MigrationLoader,
  migration: Migration,
  state: ProjectState,
  dialect: Dialect,
  backwards: boolean,
  using: string,
): Promise<{ sql: string[]; state: ProjectState }> {
  const editor = schemaEditorFor(dialect, { collectOnly: true })
  const ctx: SchemaContext = { editor, using, connection: null, dialect }
  const lines: string[] = []
  const take = () => lines.push(...editor.collectedSql.splice(0))
  void loader
  if (!backwards) {
    let current = state
    for (const op of migration.operations) {
      lines.push('--', `-- ${op.describe()}`, '--')
      const after = current.clone()
      op.stateForwards(migration.appLabel, after)
      await op.databaseForwards(migration.appLabel, ctx, current, after)
      if (!op.reducesToSql && !editor.collectedSql.length) lines.push('-- (no-op)')
      take()
      current = after
    }
    await editor.flushDeferred()
    take()
    return { sql: lines, state: current }
  }
  const steps: Array<[(typeof migration.operations)[number], ProjectState, ProjectState]> = []
  let current = state
  for (const op of migration.operations) {
    const after = current.clone()
    op.stateForwards(migration.appLabel, after)
    steps.push([op, current, after])
    current = after
  }
  for (const [op, before, after] of steps.reverse()) {
    lines.push('--', `-- ${op.describe()} (unapply)`, '--')
    await op.databaseBackwards(migration.appLabel, ctx, after, before)
    take()
  }
  await editor.flushDeferred()
  take()
  return { sql: lines, state }
}

/** SQL statements of one migration (Django's `sqlmigrate`), without touching the database. */
export async function sqlMigrate(app: string, name: string, opts: SqlMigrateOptions = {}): Promise<string[]> {
  const using = opts.using ?? DEFAULT_DB_ALIAS
  const dialect = opts.dialect ?? connections.dialect(using)
  const loader = await MigrationLoader.load({ connection: null, replaceMigrations: false })
  if (!loader.migratedApps.has(app)) throw new NodeNotFoundError(`App '${app}' does not have migrations.`)
  const migration = loader.getMigrationByPrefix(app, name)
  const state = opts.backwards
    ? loader.projectState(migration.key, false)
    : loader.projectState(migration.key, false)
  const { sql } = await collectMigrationSql(loader, migration, state, dialect, opts.backwards ?? false, using)
  const tx = opts.transaction !== false && migration.atomic && dialect === 'postgresql'
  return tx ? ['BEGIN;', ...sql, 'COMMIT;'] : sql
}

export interface SqlMigrateAllOptions {
  dialect?: Dialect
  using?: string
  /** Existing file names in the output directory (keeps their numbers; only new migrations get files). */
  existing?: string[]
}

export interface SqlMigrationFile {
  app: string
  name: string
  filename: string
  sql: string
}

const SQL_FILE = /^(\d{4})_(.+?)_(\d{4}_[A-Za-z0-9_]+)\.sql$/

/**
 * Every migration as numbered `.sql` files for `wrangler d1 migrations apply` (`sqlmigrate --all --out dir`).
 * Each file also records itself in `ghuri_migrations`, so `ghuri migrate` and wrangler agree. Files that
 * already exist keep their number; new migrations are numbered after them.
 */
export async function sqlMigrateAll(opts: SqlMigrateAllOptions = {}): Promise<SqlMigrationFile[]> {
  const using = opts.using ?? DEFAULT_DB_ALIAS
  const dialect = opts.dialect ?? connections.dialect(using)
  const loader = await MigrationLoader.load({ connection: null })
  const existing = new Map<string, string>()
  let max = 0
  for (const f of opts.existing ?? []) {
    const m = f.match(SQL_FILE)
    if (!m) continue
    max = Math.max(max, Number(m[1]))
    existing.set(`${m[2]}.${m[3]}`, f)
  }
  const files: SqlMigrationFile[] = []
  let state = loader.projectState([], true)
  for (const k of loader.graph.fullPlan()) {
    const migration = loader.graph.get(k)
    const { sql, state: next } = await collectMigrationSql(loader, migration, state, dialect, false, using)
    state = next
    const id = `${k[0]}.${k[1]}`
    if (existing.has(id)) continue
    const filename = `${String(++max).padStart(4, '0')}_${k[0]}_${k[1]}.sql`
    const record = [
      ...(loader.replacements.get(id) ?? []).map((r) => [r[0], r[1]] as const),
      [k[0], k[1]] as const,
    ]
    const now = dialect === 'postgresql' ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    const body = [
      `-- Migration ${id} (generated by ghuri sqlmigrate --all)`,
      ...sql,
      '--',
      '-- Record the migration for `ghuri migrate` / `showmigrations`',
      '--',
      `${MigrationRecorder.createTableSql(dialect)};`,
      ...record.map(
        ([a, n]) =>
          `INSERT INTO "${MigrationRecorder.TABLE}" ("app", "name", "applied") VALUES (${literal(a)}, ${literal(n)}, ${now});`,
      ),
      '',
    ]
    files.push({ app: k[0], name: k[1], filename, sql: body.join('\n') })
  }
  return files
}
