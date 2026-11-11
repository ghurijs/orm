import { IrreversibleError } from './errors'
import { isOperation, type Operation, type SchemaContext } from './operations'
import type { ProjectState } from './state'

/** `[appLabel, migrationName]`; the name may be `'__first__'` or `'__latest__'` in dependencies. */
export type MigrationKey = readonly [string, string]

export interface MigrationOptions {
  dependencies?: Array<readonly [string, string]>
  operations?: Operation[]
  /** Migrations this one replaces (squashed migrations). */
  replaces?: Array<readonly [string, string]>
  /** The app's initial migration (enables `migrate --fake-initial`). */
  initial?: boolean
  /** Run in a transaction / one D1 batch (default true). */
  atomic?: boolean
  /** Migrations of other apps that must run after this one. */
  runBefore?: Array<readonly [string, string]>
}

const MIGRATION_MARKER = Symbol.for('ghuri.orm.migrations.migration')

/**
 * One migration file: `export default new Migration({ dependencies, operations })`. The loader sets
 * `appLabel` and `name` from where it was found (`blog`, `0001_initial`).
 */
export class Migration {
  readonly [MIGRATION_MARKER] = true
  appLabel = ''
  name = ''
  dependencies: Array<readonly [string, string]>
  operations: Operation[]
  replaces: Array<readonly [string, string]>
  initial?: boolean
  atomic: boolean
  runBefore: Array<readonly [string, string]>

  constructor(opts: MigrationOptions = {}) {
    this.dependencies = [...(opts.dependencies ?? [])]
    this.operations = [...(opts.operations ?? [])]
    this.replaces = [...(opts.replaces ?? [])]
    this.initial = opts.initial
    this.atomic = opts.atomic ?? true
    this.runBefore = [...(opts.runBefore ?? [])]
    for (const op of this.operations)
      if (!isOperation(op))
        throw new TypeError(`Migration operations must be Operation instances, got ${String(op)}.`)
  }

  get key(): MigrationKey {
    return [this.appLabel, this.name]
  }

  toString(): string {
    return `${this.appLabel}.${this.name}`
  }

  /** Apply the operations to `state` (in place unless `preserve`) and return the new state. */
  mutateState(state: ProjectState, preserve = true): ProjectState {
    const s = preserve ? state.clone() : state
    for (const op of this.operations) op.stateForwards(this.appLabel, s)
    return s
  }

  /** Apply to the database; `state` is the project state before this migration. Returns the new state. */
  async apply(state: ProjectState, ctx: SchemaContext): Promise<ProjectState> {
    let current = state
    for (const op of this.operations) {
      const before = current
      const after = current.clone()
      op.stateForwards(this.appLabel, after)
      await op.databaseForwards(this.appLabel, ctx, before, after)
      current = after
    }
    return current
  }

  /** Unapply from the database; `state` is the project state before this migration was applied. */
  async unapply(state: ProjectState, ctx: SchemaContext): Promise<ProjectState> {
    const steps: Array<[Operation, ProjectState, ProjectState]> = []
    let current = state
    for (const op of this.operations) {
      if (!op.reversible) throw new IrreversibleError(`Operation ${op} in ${this} is not reversible.`)
      const before = current
      const after = current.clone()
      op.stateForwards(this.appLabel, after)
      steps.push([op, before, after])
      current = after
    }
    for (const [op, before, after] of steps.reverse())
      await op.databaseBackwards(this.appLabel, ctx, after, before)
    return state
  }

  /** Name suggested by makemigrations for these operations (`initial`, `post_slug`, `auto_…`). */
  suggestName(): string {
    if (this.initial) return 'initial'
    const fragments = this.operations.map((o) => o.migrationNameFragment)
    if (!fragments.length || fragments.some((f) => !f)) return autoName()
    const allCreate = this.operations.every((o) => o.type === 'CreateModel')
    const name = allCreate ? fragments.join('_') : fragments.join('_')
    return name.length > 52 ? `${fragments[0]}_and_more` : name
  }
}

function autoName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `auto_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

export function isMigration(v: unknown): v is Migration {
  return !!v && typeof v === 'object' && (v as any)[MIGRATION_MARKER] === true
}
