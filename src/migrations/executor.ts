import { atomic, connections, DEFAULT_DB_ALIAS } from '../db/connections'
import type { Connection } from '../db/types'
import { ManyToManyField } from '../fields/related'
import { InvalidMigrationPlan, NodeNotFoundError } from './errors'
import { keyOf } from './graph'
import { MigrationLoader, type MigrationLoaderOptions } from './loader'
import type { Migration, MigrationKey } from './migration'
import { AddField, CreateModel, type SchemaContext } from './operations'
import { MigrationRecorder } from './recorder'
import { type BaseSchemaEditor, schemaEditorFor } from './schema/index'
import type { ProjectState } from './state'

/** One step of a migration plan. */
export interface MigrationPlanEntry {
  migration: Migration
  backwards: boolean
}

/** `[app, name]` to migrate to; name `null` (or `'zero'`) unapplies every migration of the app. */
export type MigrationTarget = readonly [string, string | null]

export interface MigrateRunOptions {
  /** Mark migrations as (un)applied without running their SQL. */
  fake?: boolean
  /** Fake initial migrations whose tables already exist. */
  fakeInitial?: boolean
  /** Called as each migration starts / finishes. */
  progress?: (event: ProgressEvent) => void
}

export type ProgressEvent =
  | { action: 'apply_start' | 'unapply_start'; migration: Migration; fake: boolean }
  | {
      action: 'apply_success' | 'unapply_success'
      migration: Migration
      fake: boolean
      fakedInitial?: boolean
    }

/**
 * Applies and unapplies migrations on one database (Django's `MigrationExecutor`). Each migration runs
 * atomically: inside a transaction (SQLite / PostgreSQL) or as one `batch()` (D1), together with its
 * `ghuri_migrations` record.
 */
export class MigrationExecutor {
  constructor(
    readonly loader: MigrationLoader,
    readonly connection: Connection,
    readonly using: string = connection.alias ?? DEFAULT_DB_ALIAS,
  ) {}

  /** Executor for a database alias (loads migrations and applied records). */
  static async create(
    opts: { using?: string; connection?: Connection } & Omit<MigrationLoaderOptions, 'connection'> = {},
  ): Promise<MigrationExecutor> {
    const using = opts.using ?? opts.connection?.alias ?? DEFAULT_DB_ALIAS
    const connection = opts.connection ?? (await connections.get(using))
    const loader = await MigrationLoader.load({ ...opts, connection })
    return new MigrationExecutor(loader, connection, using)
  }

  get recorder(): MigrationRecorder {
    return new MigrationRecorder(this.connection)
  }

  /** Leaf node of every migrated app. */
  allLeafTargets(): MigrationTarget[] {
    return this.loader.graph.leafNodes().map((k) => [k[0], k[1]] as const)
  }

  /** Resolve `migrate [app] [name]` into targets. */
  targetsFor(app?: string, name?: string): MigrationTarget[] {
    if (!app) return this.allLeafTargets()
    if (!this.loader.migratedApps.has(app)) {
      if (this.loader.unmigratedApps.has(app))
        throw new NodeNotFoundError(`App '${app}' does not have migrations.`)
      throw new NodeNotFoundError(`No installed app with label '${app}'.`)
    }
    if (name === undefined) {
      const leaves = this.loader.graph.leafNodes(app)
      if (leaves.length > 1)
        throw new InvalidMigrationPlan(
          `Conflicting migrations detected in '${app}' (${leaves.map((l) => l[1]).join(', ')}); run makemigrations --merge.`,
        )
      return leaves.map((k) => [k[0], k[1]] as const)
    }
    if (name === 'zero') return [[app, null]]
    const m = this.loader.getMigrationByPrefix(app, name)
    return [[app, m.name]]
  }

  private isApplied(key: MigrationKey | string): boolean {
    return this.loader.applied.has(typeof key === 'string' ? key : keyOf(key))
  }

  /** Ordered plan reaching `targets` from the current applied set. */
  migrationPlan(targets: MigrationTarget[], cleanStart = false): MigrationPlanEntry[] {
    const graph = this.loader.graph
    const applied = cleanStart ? new Set<string>() : new Set(this.loader.applied.keys())
    const plan: MigrationPlanEntry[] = []
    const inPlan = new Set<string>()
    const push = (k: MigrationKey, backwards: boolean) => {
      const s = keyOf(k)
      if (inPlan.has(s)) return
      inPlan.add(s)
      plan.push({ migration: graph.get(k), backwards })
    }
    for (const [app, name] of targets) {
      if (name === null) {
        // Unapply everything of the app: roots and their descendants.
        for (const root of graph.rootNodes(app)) {
          for (const k of graph.backwardsPlan(root)) if (applied.has(keyOf(k))) push(k, true)
        }
        continue
      }
      const target: MigrationKey = [app, name]
      if (applied.has(keyOf(target))) {
        // Roll back the app's migrations after the target.
        const children = [...(graph.children.get(keyOf(target)) ?? [])]
          .map((c) => graph.keys.get(c)!)
          .filter((c) => c[0] === app)
        for (const child of children) {
          for (const k of graph.backwardsPlan(child)) if (applied.has(keyOf(k))) push(k, true)
        }
      } else {
        for (const k of graph.forwardsPlan(target)) if (!applied.has(keyOf(k))) push(k, false)
      }
    }
    return plan
  }

  /** Project state before / after the whole applied set, with per-migration states for backwards plans. */
  private statesForBackwards(plan: MigrationPlanEntry[]): Map<string, ProjectState> {
    const toUnapply = new Set(plan.filter((p) => p.backwards).map((p) => String(p.migration)))
    const states = new Map<string, ProjectState>()
    let state = this.loader.projectState([], true)
    // projectState([]) is the base (unmigrated apps); replay every applied migration in graph order.
    for (const k of this.loader.graph.fullPlan()) {
      const s = keyOf(k)
      if (!this.isApplied(s)) continue
      const m = this.loader.graph.get(k)
      if (toUnapply.has(s)) states.set(s, state.clone())
      state = m.mutateState(state, true)
      if (states.size === toUnapply.size) break
    }
    return states
  }

  /** Current project state of the database (every applied migration). */
  currentState(): ProjectState {
    const applied = this.loader.graph.fullPlan().filter((k) => this.isApplied(k))
    let state = this.loader.projectState([], true)
    for (const k of applied) state = this.loader.graph.get(k).mutateState(state, false)
    state.invalidate()
    return state
  }

  /**
   * Migrate the database to `targets`. Returns the plan that ran. Mixed forwards/backwards plans are
   * refused (like Django).
   */
  async migrate(
    targets: MigrationTarget[] = this.allLeafTargets(),
    opts: MigrateRunOptions & { plan?: MigrationPlanEntry[] } = {},
  ): Promise<MigrationPlanEntry[]> {
    this.loader.checkConsistentHistory()
    const plan = opts.plan ?? this.migrationPlan(targets)
    if (!plan.length) return plan
    const forwards = plan.every((p) => !p.backwards)
    const backwards = plan.every((p) => p.backwards)
    if (!forwards && !backwards)
      throw new InvalidMigrationPlan(
        'Migration plans with both forwards and backwards migrations are not supported.',
      )
    await this.recorder.ensureSchema()
    if (forwards) {
      // State before the first migration to apply: everything applied so far.
      let state = this.currentState()
      for (const { migration } of plan) state = await this.applyMigration(state, migration, opts)
    } else {
      const states = this.statesForBackwards(plan)
      for (const { migration } of plan) {
        const before = states.get(String(migration))
        if (!before) throw new InvalidMigrationPlan(`Can't compute the state before ${migration}.`)
        await this.unapplyMigration(before, migration, opts)
      }
    }
    return plan
  }

  private editorFor(conn: Connection, mode: 'transaction' | 'batch' | 'none'): BaseSchemaEditor {
    return schemaEditorFor(conn, { batch: mode === 'batch', atomic: mode === 'transaction' })
  }

  private modeFor(migration: Migration): 'transaction' | 'batch' | 'none' {
    if (!migration.atomic) return 'none'
    if (this.connection.supportsTransactions) return 'transaction'
    if (this.connection.batch) return 'batch'
    return 'none'
  }

  private recordKeys(migration: Migration): MigrationKey[] {
    const replaced = this.loader.replacements.get(String(migration))
    return replaced?.length ? [...replaced, migration.key] : [migration.key]
  }

  /** Run `fn` with an editor in the migration's atomic mode, then record. */
  private async runAtomically(
    migration: Migration,
    fn: (ctx: SchemaContext) => Promise<void>,
    record: (rec: MigrationRecorder) => Array<{ sql: string; params: unknown[] }>,
  ): Promise<void> {
    const mode = this.modeFor(migration)
    const body = async (conn: Connection) => {
      const editor = this.editorFor(conn, mode)
      const ctx: SchemaContext = { editor, using: this.using, connection: conn, dialect: conn.dialect }
      if (conn.dialect === 'sqlite' && mode !== 'none')
        await editor.execute('PRAGMA defer_foreign_keys = ON', [], { collect: false })
      await fn(ctx)
      await editor.flushDeferred()
      const statements = record(new MigrationRecorder(conn))
      if (mode === 'batch') await editor.flushBatch(statements)
      else {
        await editor.flushBatch()
        for (const s of statements) await conn.execute(s.sql, s.params)
      }
    }
    if (mode === 'transaction') {
      await atomicOn(this.using, this.connection, body)
    } else await body(this.connection)
  }

  async applyMigration(
    state: ProjectState,
    migration: Migration,
    opts: MigrateRunOptions = {},
  ): Promise<ProjectState> {
    let fake = opts.fake ?? false
    let fakedInitial = false
    opts.progress?.({ action: 'apply_start', migration, fake })
    if (!fake && opts.fakeInitial && (await this.detectSoftApplied(state, migration))) {
      fake = true
      fakedInitial = true
    }
    let after = state
    if (fake) {
      after = migration.mutateState(state, true)
      await this.runAtomically(
        migration,
        async () => {},
        (rec) => this.recordKeys(migration).map((k) => rec.appliedStatement(k[0], k[1])),
      )
    } else {
      await this.runAtomically(
        migration,
        async (ctx) => {
          after = await migration.apply(state, ctx)
        },
        (rec) => this.recordKeys(migration).map((k) => rec.appliedStatement(k[0], k[1])),
      )
    }
    for (const k of this.recordKeys(migration))
      this.loader.applied.set(keyOf(k), { id: 0, app: k[0], name: k[1], applied: new Date() })
    opts.progress?.({ action: 'apply_success', migration, fake, fakedInitial })
    return after
  }

  async unapplyMigration(
    state: ProjectState,
    migration: Migration,
    opts: MigrateRunOptions = {},
  ): Promise<void> {
    const fake = opts.fake ?? false
    opts.progress?.({ action: 'unapply_start', migration, fake })
    await this.runAtomically(
      migration,
      async (ctx) => {
        if (!fake) await migration.unapply(state, ctx)
      },
      (rec) => this.recordKeys(migration).map((k) => rec.unappliedStatement(k[0], k[1])),
    )
    for (const k of this.recordKeys(migration)) this.loader.applied.delete(keyOf(k))
    opts.progress?.({ action: 'unapply_success', migration, fake })
  }

  /**
   * `--fake-initial`: an initial migration counts as applied when every table it creates (and every column
   * it adds) already exists.
   */
  async detectSoftApplied(state: ProjectState, migration: Migration): Promise<boolean> {
    const isInitial = migration.initial ?? !migration.dependencies.some((d) => d[0] === migration.appLabel)
    if (!isInitial) return false
    const creates = migration.operations.filter((o) => o instanceof CreateModel || o instanceof AddField)
    if (!creates.length) return false
    const after = migration.mutateState(state, true)
    const editor = schemaEditorFor(this.connection)
    const tables = new Set(await editor.tableNames())
    let found = false
    for (const op of creates) {
      if (op instanceof CreateModel) {
        const model = after.apps.getModel(migration.appLabel, op.name)
        if (!model._meta.managed) continue
        if (!tables.has(model._meta.dbTable)) return false
        for (const f of model._meta.localManyToMany) {
          if (
            f instanceof ManyToManyField &&
            f.through._meta.autoCreated &&
            !tables.has(f.through._meta.dbTable)
          )
            return false
        }
        found = true
      } else if (op instanceof AddField) {
        const model = after.apps.getModel(migration.appLabel, op.modelName)
        if (!model._meta.managed) continue
        const field = model._meta.getForwardField(op.name)!
        if (field instanceof ManyToManyField) {
          if (field.through._meta.autoCreated && !tables.has(field.through._meta.dbTable)) return false
        } else {
          if (!tables.has(model._meta.dbTable)) return false
          const cols = await editor.columnNames(model._meta.dbTable)
          if (!cols.includes(field.column)) return false
        }
        found = true
      }
    }
    return found
  }
}

/** Run `fn` in `atomic()` on alias `using` when it's configured, else a transaction on `connection`. */
async function atomicOn<T>(
  using: string,
  connection: Connection,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  let configured = false
  try {
    configured = (await connections.get(using)) === connection
  } catch {
    configured = false
  }
  if (configured) return atomic(async () => fn(await connections.get(using)), { using })
  return connection.transaction(fn)
}
