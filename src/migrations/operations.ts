import { ImproperlyConfigured } from '@ghuri/core'
import { splitStatements } from '../db/d1'
import type { Connection } from '../db/types'
import type { FieldDeconstruction } from '../fields/base'
import type { ManyToManyField } from '../fields/related'
import type { ConstraintSpec, IndexSpec, ModelClass } from '../models/types'
import type { Dialect } from '../query/sql'
import type { BaseSchemaEditor } from './schema/base'
import {
  ALTER_OPTION_KEYS,
  type FieldSpec,
  flattenFieldSpec,
  ModelState,
  normalizeFieldSpec,
  normalizeUniqueTogether,
  type ProjectState,
  type StateApps,
} from './state'

/** What operations get when they touch the database. */
export interface SchemaContext {
  editor: BaseSchemaEditor
  /** Database alias. */
  using: string
  /** The live connection; null when only collecting SQL (`sqlmigrate`). */
  connection: Connection | null
  dialect: Dialect
}

const OPERATION_MARKER = Symbol.for('ghuri.orm.migrations.operation')

/**
 * Base class of migration operations (Django's `Operation`). Each one changes the project state
 * (`stateForwards`) and the database (`databaseForwards` / `databaseBackwards`), describes itself and
 * serializes to TypeScript (`deconstruct()` → `ops.Name({...})`).
 */
export abstract class Operation {
  readonly [OPERATION_MARKER] = true
  /** Factory / class name used when writing migration files (`CreateModel`). */
  abstract readonly type: string
  /** Can it be unapplied? */
  reversible = true
  /** Does it change the database schema? (false: state-only, e.g. AlterModelOptions). */
  readonly reducesToSql: boolean = true

  abstract stateForwards(appLabel: string, state: ProjectState): void
  abstract databaseForwards(
    appLabel: string,
    ctx: SchemaContext,
    fromState: ProjectState,
    toState: ProjectState,
  ): Promise<void>
  /** `fromState` is the state after this operation, `toState` the one before (Django's convention). */
  abstract databaseBackwards(
    appLabel: string,
    ctx: SchemaContext,
    fromState: ProjectState,
    toState: ProjectState,
  ): Promise<void>
  abstract describe(): string
  /** Constructor options, serialized into migration files. */
  abstract deconstruct(): Record<string, unknown>

  /** Fragment for automatic migration names (`post_slug`), or null. */
  get migrationNameFragment(): string | null {
    return null
  }

  /** Does the operation concern model `name` of `appLabel` (dependency / optimization hints)? */
  referencesModel(_name: string, _appLabel: string): boolean {
    return true
  }

  toString(): string {
    return `<${this.type}: ${this.describe()}>`
  }
}

export function isOperation(v: unknown): v is Operation {
  return !!v && typeof v === 'object' && (v as any)[OPERATION_MARKER] === true
}

function allowMigrate(model: ModelClass): boolean {
  return model._meta.managed !== false
}

function lower(s: string): string {
  return s.toLowerCase()
}

// ---- models -------------------------------------------------------------------------------------

export interface CreateModelOptions {
  name: string
  fields: Record<string, FieldSpec>
  options?: Record<string, unknown>
}

/** Create a model's table (with its M2M tables, indexes and unique sets). */
export class CreateModel extends Operation {
  readonly type = 'CreateModel'
  readonly name: string
  readonly fields: Record<string, FieldDeconstruction>
  readonly options: Record<string, unknown>

  constructor(opts: CreateModelOptions) {
    super()
    this.name = opts.name
    this.fields = Object.fromEntries(Object.entries(opts.fields).map(([k, v]) => [k, normalizeFieldSpec(v)]))
    this.options = { ...(opts.options ?? {}) }
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    state.addModel(new ModelState(appLabel, this.name, this.fields, this.options))
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.name)
    if (allowMigrate(model)) await ctx.editor.createModel(model)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState) {
    const model = from.apps.getModel(appLabel, this.name)
    if (allowMigrate(model)) await ctx.editor.deleteModel(model)
  }

  describe(): string {
    return `Create model ${this.name}`
  }

  override get migrationNameFragment(): string {
    return lower(this.name)
  }

  override referencesModel(name: string, appLabel: string): boolean {
    if (lower(name) === lower(this.name)) return true
    const label = `${appLabel}.${name}`.toLowerCase()
    return Object.values(this.fields).some(
      (f) =>
        (typeof f.options.to === 'string' && f.options.to.toLowerCase() === label) ||
        (typeof f.options.through === 'string' && f.options.through.toLowerCase() === label),
    )
  }

  deconstruct(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      fields: Object.fromEntries(Object.entries(this.fields).map(([k, v]) => [k, flattenFieldSpec(v)])),
    }
    if (Object.keys(this.options).length) out.options = this.options
    return out
  }
}

/** Drop a model's table (and its auto-created M2M tables). */
export class DeleteModel extends Operation {
  readonly type = 'DeleteModel'
  readonly name: string

  constructor(opts: { name: string }) {
    super()
    this.name = opts.name
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    state.removeModel(appLabel, this.name)
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState) {
    const model = from.apps.getModel(appLabel, this.name)
    if (allowMigrate(model)) await ctx.editor.deleteModel(model)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.name)
    if (allowMigrate(model)) await ctx.editor.createModel(model)
  }

  describe(): string {
    return `Delete model ${this.name}`
  }

  override get migrationNameFragment(): string {
    return `delete_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    return { name: this.name }
  }
}

/** M2M fields whose through table / columns may change when a model or table is renamed. */
async function alterRelatedManyToMany(
  ctx: SchemaContext,
  fromApps: StateApps,
  toApps: StateApps,
  oldModel: ModelClass,
  newModel: ModelClass,
  includeRemote: boolean,
): Promise<void> {
  for (const f of newModel._meta.localManyToMany) {
    const old = oldModel._meta.localManyToMany.find((x) => x.name === f.name)
    if (old) await ctx.editor.alterField(newModel, old, f, { oldModel })
  }
  if (!includeRemote) return
  for (const m of toApps.getModels()) {
    if (m === newModel) continue
    for (const f of m._meta.localManyToMany) {
      if (f.relatedModel !== newModel) continue
      const oldOwner = fromApps.getModel(m._meta.label)
      const old = oldOwner._meta.localManyToMany.find((x) => x.name === f.name) as ManyToManyField | undefined
      if (old) await ctx.editor.alterField(m, old, f, { oldModel: oldOwner })
    }
  }
}

/** Rename a model (and its default table, M2M tables and references from other models). */
export class RenameModel extends Operation {
  readonly type = 'RenameModel'
  readonly oldName: string
  readonly newName: string

  constructor(opts: { oldName: string; newName: string }) {
    super()
    this.oldName = opts.oldName
    this.newName = opts.newName
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.oldName)
    state.removeModel(appLabel, this.oldName)
    const renamed = ms.clone()
    renamed.name = this.newName
    state.addModel(renamed)
    state.renameRelationTargets(`${appLabel}.${this.oldName}`, `${appLabel}.${this.newName}`)
  }

  private async rename(
    appLabel: string,
    ctx: SchemaContext,
    from: ProjectState,
    to: ProjectState,
    oldName: string,
    newName: string,
  ) {
    const oldModel = from.apps.getModel(appLabel, oldName)
    const newModel = to.apps.getModel(appLabel, newName)
    if (!allowMigrate(newModel)) return
    await ctx.editor.renameModel(oldModel, newModel)
    await alterRelatedManyToMany(ctx, from.apps, to.apps, oldModel, newModel, true)
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    await this.rename(appLabel, ctx, from, to, this.oldName, this.newName)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    await this.rename(appLabel, ctx, from, to, this.newName, this.oldName)
  }

  describe(): string {
    return `Rename model ${this.oldName} to ${this.newName}`
  }

  override get migrationNameFragment(): string {
    return `rename_${lower(this.oldName)}_${lower(this.newName)}`
  }

  deconstruct(): Record<string, unknown> {
    return { oldName: this.oldName, newName: this.newName }
  }
}

/** Rename a model's table (`Meta.dbTable`). `table: null` restores the default name. */
export class AlterModelTable extends Operation {
  readonly type = 'AlterModelTable'
  readonly name: string
  readonly table: string | null

  constructor(opts: { name: string; table: string | null }) {
    super()
    this.name = opts.name
    this.table = opts.table
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.name)
    if (this.table === null) delete ms.options.dbTable
    else ms.options.dbTable = this.table
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.name)
    const newModel = to.apps.getModel(appLabel, this.name)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterDbTable(newModel, oldModel._meta.dbTable, newModel._meta.dbTable)
    await alterRelatedManyToMany(ctx, from.apps, to.apps, oldModel, newModel, false)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    await this.databaseForwards(appLabel, ctx, from, to)
  }

  describe(): string {
    return `Rename table for ${this.name} to ${this.table ?? '(default)'}`
  }

  override get migrationNameFragment(): string {
    return `alter_${lower(this.name)}_table`
  }

  deconstruct(): Record<string, unknown> {
    return { name: this.name, table: this.table }
  }
}

/** Change Meta options that don't touch the database (ordering, verbose names, permissions…). */
export class AlterModelOptions extends Operation {
  readonly type = 'AlterModelOptions'
  override readonly reducesToSql = false
  readonly name: string
  readonly options: Record<string, unknown>

  constructor(opts: { name: string; options: Record<string, unknown> }) {
    super()
    this.name = opts.name
    this.options = { ...opts.options }
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.name)
    for (const k of ALTER_OPTION_KEYS) {
      if (this.options[k] !== undefined) ms.options[k] = this.options[k]
      else delete ms.options[k]
    }
    state.invalidate()
  }

  async databaseForwards() {}
  async databaseBackwards() {}

  describe(): string {
    return `Change Meta options on ${this.name}`
  }

  override get migrationNameFragment(): string {
    return `alter_${lower(this.name)}_options`
  }

  deconstruct(): Record<string, unknown> {
    return { name: this.name, options: this.options }
  }
}

/** Change `Meta.uniqueTogether`. */
export class AlterUniqueTogether extends Operation {
  readonly type = 'AlterUniqueTogether'
  readonly name: string
  readonly uniqueTogether: string[][]

  constructor(opts: { name: string; uniqueTogether: string[][] | string[] }) {
    super()
    this.name = opts.name
    this.uniqueTogether = normalizeUniqueTogether(opts.uniqueTogether)
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.name)
    if (this.uniqueTogether.length) ms.options.uniqueTogether = this.uniqueTogether.map((s) => [...s])
    else delete ms.options.uniqueTogether
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.name)
    const newModel = to.apps.getModel(appLabel, this.name)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterUniqueTogether(
      newModel,
      oldModel._meta.uniqueTogether,
      newModel._meta.uniqueTogether,
      oldModel,
    )
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    await this.databaseForwards(appLabel, ctx, from, to)
  }

  describe(): string {
    const n = this.uniqueTogether.length
    return `Alter unique_together for ${this.name} (${n} constraint${n === 1 ? '' : 's'})`
  }

  override get migrationNameFragment(): string {
    return `alter_${lower(this.name)}_unique_together`
  }

  deconstruct(): Record<string, unknown> {
    return { name: this.name, uniqueTogether: this.uniqueTogether }
  }
}

// ---- fields -------------------------------------------------------------------------------------

function fieldOf(model: ModelClass, name: string) {
  const f = model._meta.getForwardField(name)
  if (!f)
    throw new ImproperlyConfigured(`${model._meta.label} has no field '${name}' in the migration state.`)
  return f
}

export interface AddFieldOptions {
  modelName: string
  name: string
  field: FieldSpec
  /** Value for existing rows (asked by makemigrations); not part of the field definition. */
  oneOffDefault?: unknown
}

/** Add a field (column, or M2M table). */
export class AddField extends Operation {
  readonly type = 'AddField'
  readonly modelName: string
  readonly name: string
  readonly field: FieldDeconstruction
  readonly oneOffDefault: unknown

  constructor(opts: AddFieldOptions) {
    super()
    this.modelName = opts.modelName
    this.name = opts.name
    this.field = normalizeFieldSpec(opts.field)
    this.oneOffDefault = opts.oneOffDefault
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    ms.fields.set(this.name, { type: this.field.type, options: { ...this.field.options } })
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(model)) return
    await ctx.editor.addField(model, fieldOf(model, this.name), { default: this.oneOffDefault })
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const model = from.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(model)) return
    await ctx.editor.removeField(model, fieldOf(model, this.name), {
      toModel: to.apps.getModel(appLabel, this.modelName),
    })
  }

  describe(): string {
    return `Add field ${this.name} to ${lower(this.modelName)}`
  }

  override get migrationNameFragment(): string {
    return `${lower(this.modelName)}_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      modelName: this.modelName,
      name: this.name,
      field: flattenFieldSpec(this.field),
    }
    if (this.oneOffDefault !== undefined) out.oneOffDefault = this.oneOffDefault
    return out
  }
}

/** Remove a field (column, or M2M table). */
export class RemoveField extends Operation {
  readonly type = 'RemoveField'
  readonly modelName: string
  readonly name: string

  constructor(opts: { modelName: string; name: string }) {
    super()
    this.modelName = opts.modelName
    this.name = opts.name
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    ms.fields.delete(this.name)
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const model = from.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(model)) return
    await ctx.editor.removeField(model, fieldOf(model, this.name), {
      toModel: to.apps.getModel(appLabel, this.modelName),
    })
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(model)) return
    await ctx.editor.addField(model, fieldOf(model, this.name))
  }

  describe(): string {
    return `Remove field ${this.name} from ${lower(this.modelName)}`
  }

  override get migrationNameFragment(): string {
    return `remove_${lower(this.modelName)}_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, name: this.name }
  }
}

export interface AlterFieldOptions {
  modelName: string
  name: string
  field: FieldSpec
  /** Value for existing NULL rows when the field becomes NOT NULL (asked by makemigrations). */
  oneOffDefault?: unknown
}

/** Change a field's definition (type, null, unique, default, relation…). */
export class AlterField extends Operation {
  readonly type = 'AlterField'
  readonly modelName: string
  readonly name: string
  readonly field: FieldDeconstruction
  readonly oneOffDefault: unknown

  constructor(opts: AlterFieldOptions) {
    super()
    this.modelName = opts.modelName
    this.name = opts.name
    this.field = normalizeFieldSpec(opts.field)
    this.oneOffDefault = opts.oneOffDefault
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    if (!ms.fields.has(this.name))
      throw new ImproperlyConfigured(`${ms.label} has no field '${this.name}' to alter.`)
    ms.fields.set(this.name, { type: this.field.type, options: { ...this.field.options } })
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.modelName)
    const newModel = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterField(newModel, fieldOf(oldModel, this.name), fieldOf(newModel, this.name), {
      oldModel,
      default: this.oneOffDefault,
    })
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.modelName)
    const newModel = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterField(newModel, fieldOf(oldModel, this.name), fieldOf(newModel, this.name), {
      oldModel,
    })
  }

  describe(): string {
    return `Alter field ${this.name} on ${lower(this.modelName)}`
  }

  override get migrationNameFragment(): string {
    return `alter_${lower(this.modelName)}_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      modelName: this.modelName,
      name: this.name,
      field: flattenFieldSpec(this.field),
    }
    if (this.oneOffDefault !== undefined) out.oneOffDefault = this.oneOffDefault
    return out
  }
}

/** Rename a field (and its column unless `dbColumn` is set). */
export class RenameField extends Operation {
  readonly type = 'RenameField'
  readonly modelName: string
  readonly oldName: string
  readonly newName: string

  constructor(opts: { modelName: string; oldName: string; newName: string }) {
    super()
    this.modelName = opts.modelName
    this.oldName = opts.oldName
    this.newName = opts.newName
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    const entries = [...ms.fields].map(([k, v]) => [k === this.oldName ? this.newName : k, v] as const)
    if (!ms.fields.has(this.oldName))
      throw new ImproperlyConfigured(`${ms.label} has no field '${this.oldName}' to rename.`)
    ms.fields.clear()
    for (const [k, v] of entries) ms.fields.set(k, v)
    const ren = (names: string[]) =>
      names.map((n) => {
        const desc = n.startsWith('-')
        const base = desc ? n.slice(1) : n
        return base === this.oldName ? `${desc ? '-' : ''}${this.newName}` : n
      })
    if (ms.options.uniqueTogether) ms.options.uniqueTogether = ms.uniqueTogether.map(ren)
    if (ms.options.indexes) ms.options.indexes = ms.indexes.map((i) => ({ ...i, fields: ren(i.fields) }))
    if (ms.options.constraints)
      ms.options.constraints = ms.constraints.map((c) =>
        c.type === 'unique' ? { ...c, fields: ren(c.fields) } : c,
      )
    if (Array.isArray(ms.options.ordering)) ms.options.ordering = ren(ms.options.ordering as string[])
    // toField / throughFields references from other models.
    const label = ms.label.toLowerCase()
    for (const other of state.models.values()) {
      for (const spec of other.fields.values()) {
        const to = spec.options.to
        if (typeof to !== 'string' || to.toLowerCase() !== label) continue
        if (spec.options.toField === this.oldName) spec.options.toField = this.newName
      }
    }
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.modelName)
    const newModel = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterField(newModel, fieldOf(oldModel, this.oldName), fieldOf(newModel, this.newName), {
      oldModel,
    })
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const oldModel = from.apps.getModel(appLabel, this.modelName)
    const newModel = to.apps.getModel(appLabel, this.modelName)
    if (!allowMigrate(newModel)) return
    await ctx.editor.alterField(newModel, fieldOf(oldModel, this.newName), fieldOf(newModel, this.oldName), {
      oldModel,
    })
  }

  describe(): string {
    return `Rename field ${this.oldName} on ${lower(this.modelName)} to ${this.newName}`
  }

  override get migrationNameFragment(): string {
    return `rename_${lower(this.oldName)}_${lower(this.modelName)}_${lower(this.newName)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, oldName: this.oldName, newName: this.newName }
  }
}

// ---- indexes & constraints ----------------------------------------------------------------------

/** Add a `Meta.indexes` entry (must be named). */
export class AddIndex extends Operation {
  readonly type = 'AddIndex'
  readonly modelName: string
  readonly index: IndexSpec

  constructor(opts: { modelName: string; index: IndexSpec }) {
    super()
    if (!opts.index.name)
      throw new ImproperlyConfigured('Indexes passed to AddIndex operations require a name.')
    this.modelName = opts.modelName
    this.index = { ...opts.index, fields: [...opts.index.fields] }
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    ms.options.indexes = [...ms.indexes, { ...this.index }]
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.modelName)
    if (allowMigrate(model)) await ctx.editor.addIndex(model, this.index)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState) {
    const model = from.apps.getModel(appLabel, this.modelName)
    if (allowMigrate(model)) await ctx.editor.removeIndex(model, this.index)
  }

  describe(): string {
    return `Create index ${this.index.name} on field(s) ${this.index.fields.join(', ')} of model ${this.modelName}`
  }

  override get migrationNameFragment(): string {
    return `${lower(this.modelName)}_${lower(this.index.name!)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, index: this.index }
  }
}

/** Remove a named `Meta.indexes` entry. */
export class RemoveIndex extends Operation {
  readonly type = 'RemoveIndex'
  readonly modelName: string
  readonly name: string

  constructor(opts: { modelName: string; name: string }) {
    super()
    this.modelName = opts.modelName
    this.name = opts.name
  }

  private find(ms: ModelState): IndexSpec {
    const idx = ms.indexes.find((i) => i.name === this.name)
    if (!idx) throw new ImproperlyConfigured(`${ms.label} has no index named '${this.name}'.`)
    return idx
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    this.find(ms)
    const rest = ms.indexes.filter((i) => i.name !== this.name)
    if (rest.length) ms.options.indexes = rest
    else delete ms.options.indexes
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState) {
    const model = from.apps.getModel(appLabel, this.modelName)
    const idx = this.find(from.getModel(appLabel, this.modelName))
    if (allowMigrate(model)) await ctx.editor.removeIndex(model, idx)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.modelName)
    const idx = this.find(to.getModel(appLabel, this.modelName))
    if (allowMigrate(model)) await ctx.editor.addIndex(model, idx)
  }

  describe(): string {
    return `Remove index ${this.name} from ${this.modelName}`
  }

  override get migrationNameFragment(): string {
    return `remove_${lower(this.modelName)}_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, name: this.name }
  }
}

/** Add a `Meta.constraints` entry (unique or check; check constraints rebuild the table on SQLite). */
export class AddConstraint extends Operation {
  readonly type = 'AddConstraint'
  readonly modelName: string
  readonly constraint: ConstraintSpec

  constructor(opts: { modelName: string; constraint: ConstraintSpec }) {
    super()
    this.modelName = opts.modelName
    this.constraint = { ...opts.constraint }
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    ms.options.constraints = [...ms.constraints, { ...this.constraint }]
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const model = to.apps.getModel(appLabel, this.modelName)
    if (allowMigrate(model)) await ctx.editor.addConstraint(model, this.constraint)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, from: ProjectState) {
    const model = from.apps.getModel(appLabel, this.modelName)
    if (allowMigrate(model)) await ctx.editor.removeConstraint(model, this.constraint)
  }

  describe(): string {
    return `Create constraint ${this.constraint.name} on model ${this.modelName}`
  }

  override get migrationNameFragment(): string {
    return `${lower(this.modelName)}_${lower(this.constraint.name)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, constraint: this.constraint }
  }
}

/** Remove a named `Meta.constraints` entry. */
export class RemoveConstraint extends Operation {
  readonly type = 'RemoveConstraint'
  readonly modelName: string
  readonly name: string

  constructor(opts: { modelName: string; name: string }) {
    super()
    this.modelName = opts.modelName
    this.name = opts.name
  }

  private find(ms: ModelState): ConstraintSpec {
    const c = ms.constraints.find((x) => x.name === this.name)
    if (!c) throw new ImproperlyConfigured(`${ms.label} has no constraint named '${this.name}'.`)
    return c
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    const ms = state.getModel(appLabel, this.modelName)
    this.find(ms)
    const rest = ms.constraints.filter((c) => c.name !== this.name)
    if (rest.length) ms.options.constraints = rest
    else delete ms.options.constraints
    state.invalidate()
  }

  async databaseForwards(appLabel: string, ctx: SchemaContext, from: ProjectState, to: ProjectState) {
    const c = this.find(from.getModel(appLabel, this.modelName))
    // SQLite rebuilds from the model without the constraint; the from-model still has it.
    const model = from.apps.getModel(appLabel, this.modelName)
    void to
    if (allowMigrate(model)) await ctx.editor.removeConstraint(model, c)
  }

  async databaseBackwards(appLabel: string, ctx: SchemaContext, _from: ProjectState, to: ProjectState) {
    const c = this.find(to.getModel(appLabel, this.modelName))
    const model = to.apps.getModel(appLabel, this.modelName)
    if (allowMigrate(model)) await ctx.editor.addConstraint(model, c)
  }

  describe(): string {
    return `Remove constraint ${this.name} from model ${this.modelName}`
  }

  override get migrationNameFragment(): string {
    return `remove_${lower(this.modelName)}_${lower(this.name)}`
  }

  deconstruct(): Record<string, unknown> {
    return { modelName: this.modelName, name: this.name }
  }
}

// ---- special ------------------------------------------------------------------------------------

/** SQL for RunSQL: one string (may contain several `;`-separated statements) or a list. */
export type SqlInput = string | Array<string | { sql: string; params?: unknown[] }>

export interface RunSQLOptions {
  /** SQL for both dialects. */
  sql?: SqlInput
  /** SQLite / D1 only. */
  sqlite?: SqlInput
  /** PostgreSQL only. */
  postgresql?: SqlInput
  /** SQL to unapply; omit to make the operation irreversible, `[]` for a no-op. */
  reverse?: SqlInput | { sql?: SqlInput; sqlite?: SqlInput; postgresql?: SqlInput }
  /** State changes the SQL performs (so the autodetector knows about them). */
  stateOperations?: Operation[]
}

function sqlStatements(input: SqlInput | undefined): Array<{ sql: string; params?: unknown[] }> {
  if (input === undefined) return []
  const list = typeof input === 'string' ? [input] : input
  const out: Array<{ sql: string; params?: unknown[] }> = []
  for (const item of list) {
    if (typeof item === 'string') for (const s of splitStatements(item)) out.push({ sql: s })
    else out.push(item)
  }
  return out
}

/**
 * Run raw SQL, per dialect: `RunSQL({ sqlite: '…', postgresql: '…', reverse: { … } })`. A dialect without
 * SQL is skipped, which keeps migrations portable.
 */
export class RunSQL extends Operation {
  readonly type = 'RunSQL'
  /** Use as `reverse` for a reversible no-op. */
  static readonly noop: SqlInput = []
  readonly opts: RunSQLOptions

  constructor(opts: RunSQLOptions | string) {
    super()
    this.opts = typeof opts === 'string' ? { sql: opts } : { ...opts }
    this.reversible = this.opts.reverse !== undefined
  }

  private forDialect(
    source: { sql?: SqlInput; sqlite?: SqlInput; postgresql?: SqlInput },
    dialect: Dialect,
  ): Array<{ sql: string; params?: unknown[] }> {
    return sqlStatements(source[dialect] ?? source.sql)
  }

  stateForwards(appLabel: string, state: ProjectState): void {
    for (const op of this.opts.stateOperations ?? []) op.stateForwards(appLabel, state)
  }

  async databaseForwards(_appLabel: string, ctx: SchemaContext) {
    for (const s of this.forDialect(this.opts, ctx.dialect)) await ctx.editor.execute(s.sql, s.params ?? [])
  }

  async databaseBackwards(_appLabel: string, ctx: SchemaContext) {
    const rev = this.opts.reverse
    if (rev === undefined)
      throw new ImproperlyConfigured('RunSQL operation is not reversible (no `reverse`).')
    const src = typeof rev === 'string' || Array.isArray(rev) ? { sql: rev } : rev
    for (const s of this.forDialect(src, ctx.dialect)) await ctx.editor.execute(s.sql, s.params ?? [])
  }

  describe(): string {
    return 'Raw SQL operation'
  }

  deconstruct(): Record<string, unknown> {
    return { ...this.opts }
  }
}

/** `RunCode` callback: historical models, the connection (null in sqlmigrate) and context. */
export type RunCodeFn = (
  apps: StateApps,
  connection: Connection,
  ctx: { using: string; editor: BaseSchemaEditor },
) => unknown | Promise<unknown>

/**
 * Data migration in TypeScript (Django's `RunPython`): `RunCode(async (apps, conn, { using }) => { const Post =
 * apps.getModel('blog.Post'); await Post.objects.using(using).update({ … }) })`. Models are the historical
 * versions at this point of the migration history.
 */
export class RunCode extends Operation {
  readonly type = 'RunCode'
  /** Use as reverse code for a reversible no-op. */
  static readonly noop: RunCodeFn = () => {}
  override readonly reducesToSql = false
  readonly code: RunCodeFn
  readonly reverseCode?: RunCodeFn

  constructor(code: RunCodeFn, reverseCode?: RunCodeFn) {
    super()
    if (typeof code !== 'function') throw new TypeError('RunCode needs a function.')
    this.code = code
    this.reverseCode = reverseCode
    this.reversible = typeof reverseCode === 'function'
  }

  stateForwards(): void {}

  private async run(fn: RunCodeFn, ctx: SchemaContext, state: ProjectState) {
    if (!ctx.connection || ctx.editor.isCollectOnly) {
      ctx.editor.collectedSql.push(
        `-- RunCode: ${fn.name || 'anonymous function'} (not representable as SQL)`,
      )
      return
    }
    await ctx.editor.flushBatch()
    await fn(state.apps, ctx.connection, { using: ctx.using, editor: ctx.editor })
  }

  async databaseForwards(_appLabel: string, ctx: SchemaContext, from: ProjectState) {
    await this.run(this.code, ctx, from)
  }

  async databaseBackwards(_appLabel: string, ctx: SchemaContext, from: ProjectState) {
    if (!this.reverseCode)
      throw new ImproperlyConfigured('RunCode operation is not reversible (no reverse code).')
    await this.run(this.reverseCode, ctx, from)
  }

  describe(): string {
    return 'Raw TypeScript operation'
  }

  deconstruct(): Record<string, unknown> {
    return { code: this.code, reverseCode: this.reverseCode }
  }
}

// ---- callable classes (`ops.CreateModel({...})` and `new CreateModel({...})`) ---------------------

type Callable<C extends abstract new (...args: any) => any> = C &
  ((...args: ConstructorParameters<C>) => InstanceType<C>)

function callable<C extends new (...args: any) => any>(cls: C): Callable<C> {
  return new Proxy(cls, {
    apply(target, _this, args) {
      return new target(...args)
    },
  }) as Callable<C>
}

/** Operation factories for migration files: `import { operations as ops } from '@ghuri/orm/migrations'`. */
export const operations = {
  CreateModel: callable(CreateModel),
  DeleteModel: callable(DeleteModel),
  RenameModel: callable(RenameModel),
  AlterModelTable: callable(AlterModelTable),
  AlterModelOptions: callable(AlterModelOptions),
  AlterUniqueTogether: callable(AlterUniqueTogether),
  AddField: callable(AddField),
  RemoveField: callable(RemoveField),
  AlterField: callable(AlterField),
  RenameField: callable(RenameField),
  AddIndex: callable(AddIndex),
  RemoveIndex: callable(RemoveIndex),
  AddConstraint: callable(AddConstraint),
  RemoveConstraint: callable(RemoveConstraint),
  RunSQL: callable(RunSQL),
  RunCode: callable(RunCode),
}
