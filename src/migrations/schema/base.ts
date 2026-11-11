import { NotSupportedError } from '../../errors'
import type { Field } from '../../fields/base'
import { ForeignKey, ManyToManyField } from '../../fields/related'
import type { ConstraintSpec, IndexSpec, ModelClass } from '../../models/types'
import { type Dialect, literal, quoteName } from '../../query/sql'
import { shortHash } from '../../utils'

/** What the schema editor needs from a connection (a full `Connection` works). */
export interface SchemaConnection {
  dialect: Dialect
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] } | unknown>
  batch?(statements: Array<{ sql: string; params?: unknown[] }>): Promise<unknown>
  features?: { supportsSavepoints?: boolean; supportsTransactions?: boolean }
}

export interface SchemaEditorOptions {
  /** Only collect SQL into `collectedSql` without executing (sqlmigrate). */
  collectOnly?: boolean
  /**
   * Buffer statements and send them with `connection.batch()` on `flushBatch()` (D1: one atomic batch per
   * migration). Introspection queries flush the buffer first.
   */
  batch?: boolean
  /** The editor runs inside a transaction (atomic migration); SQLite table rebuilds rely on it. */
  atomic?: boolean
}

/** A one-off value used to fill existing rows (AddField / AlterField null → not null). */
export interface BackfillOption {
  /** Value for existing rows; `undefined` means "use the field's own default". */
  default?: unknown
}

export interface AlterFieldOptions extends BackfillOption {
  /** Model the old field belongs to (from-state). Defaults to `oldField.model`. */
  oldModel?: ModelClass
}

export interface RemoveFieldOptions {
  /** The model without the field (to-state); SQLite rebuilds use it as the new definition. */
  toModel?: ModelClass
}

/** Unique set of a table (uniqueTogether entry or unique constraint). */
export interface UniqueSpec {
  fields: string[]
  name: string
  condition?: string
}

/** Everything that makes up a table: used by the SQLite table rebuild. */
export interface TableDefinition {
  model: ModelClass
  table: string
  fields: Field<any, any>[]
  checks: Array<Extract<ConstraintSpec, { type: 'check' }>>
  indexes: IndexSpec[]
  uniques: UniqueSpec[]
}

const MAX_NAME_LENGTH = 63

/** Marker for "no value" (distinct from `null`). */
export const NO_DEFAULT: unique symbol = Symbol('ghuri.noDefault') as any

/**
 * Turns model definitions into DDL. Operates on model classes (`_meta`), so historical models rendered by
 * the migrations state work the same as live models.
 *
 * Structure (Django's `BaseDatabaseSchemaEditor`):
 * - `columnSql()` / `tableSql()` build definitions from `field.dbType(dialect)` (the type map lives in
 *   `fields/base.ts#DB_TYPES`, extendable with `registerDbType`).
 * - `createModel()` / `deleteModel()` handle tables, indexes, unique constraints and auto-created M2M tables.
 * - `addField()` / `removeField()` / `alterField()` change columns (SQLite rebuilds the table when it
 *   can't ALTER in place, like Django).
 * - Statements that must run after every table exists (PostgreSQL foreign keys) go to `deferredSql`,
 *   flushed by `flushDeferred()` / `run()`.
 * - Dialect subclasses override the `sql*` templates and hooks (`columnSqlExtra`, `foreignKeySql`, …).
 */
export abstract class BaseSchemaEditor {
  abstract readonly dialect: Dialect
  readonly collectedSql: string[] = []
  deferredSql: string[] = []
  /** Statements waiting for `flushBatch()` (batch mode). */
  pendingBatch: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    readonly connection: SchemaConnection | null,
    readonly options: SchemaEditorOptions = {},
  ) {}

  /** Run `fn` with this editor and flush deferred SQL at the end (like Django's `with schema_editor()`). */
  async run<T>(fn: (editor: this) => Promise<T>): Promise<T> {
    const r = await fn(this)
    await this.flushDeferred()
    await this.flushBatch()
    return r
  }

  async flushDeferred(): Promise<void> {
    const pending = this.deferredSql
    this.deferredSql = []
    for (const s of pending) await this.execute(s)
  }

  /** Send buffered statements in one `connection.batch()` (atomic on D1). */
  async flushBatch(extra: Array<{ sql: string; params?: unknown[] }> = []): Promise<void> {
    const statements = [...this.pendingBatch, ...extra]
    this.pendingBatch = []
    if (!statements.length || !this.connection || this.options.collectOnly) return
    if (this.connection.batch) await this.connection.batch(statements)
    else for (const s of statements) await this.connection.execute(s.sql, s.params ?? [])
  }

  get isCollectOnly(): boolean {
    return Boolean(this.options.collectOnly || !this.connection)
  }

  quoteName(name: string): string {
    return quoteName(name)
  }

  async execute(sql: string, params: unknown[] = [], opts: { collect?: boolean } = {}): Promise<void> {
    if (opts.collect !== false)
      this.collectedSql.push(params.length ? `${sql}; -- params: ${JSON.stringify(params)}` : `${sql};`)
    if (this.isCollectOnly) return
    if (this.options.batch) {
      this.pendingBatch.push({ sql, params })
      return
    }
    await this.connection!.execute(sql, params)
  }

  /** Run a read query for introspection (always executed; flushes a pending batch first). */
  protected async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (this.isCollectOnly) return []
    await this.flushBatch()
    const res = (await this.connection!.execute(sql, params)) as { rows?: Record<string, unknown>[] }
    return res?.rows ?? []
  }

  // ---- naming -----------------------------------------------------------------------------------

  /** Deterministic identifier `${table}_${columns}_${hash}${suffix}` limited to 63 chars. */
  createName(table: string, columns: string[], suffix: string): string {
    const hash = shortHash(table, ...columns, suffix)
    let base = `${table}_${columns.join('_')}`
    const max = MAX_NAME_LENGTH - hash.length - suffix.length - 1
    if (base.length > max) base = base.slice(0, max)
    return `${base}_${hash}${suffix}`
  }

  // ---- column / table definitions ---------------------------------------------------------------

  columnType(field: Field<any, any>): string | null {
    return field.dbType(this.dialect)
  }

  /** Extra column clauses for auto fields (AUTOINCREMENT / IDENTITY). */
  protected abstract autoFieldSql(field: Field<any, any>): string

  /** Inline REFERENCES clause, or null when foreign keys are added later (deferred). */
  protected abstract inlineForeignKeySql(model: ModelClass, field: ForeignKey): string | null

  defaultSql(field: Field<any, any>): string | null {
    if (field.dbDefault === undefined) return null
    return `DEFAULT ${literal(field.dbDefault, this.dialect)}`
  }

  /** `"col" type [NOT NULL] [PRIMARY KEY …] [UNIQUE] [DEFAULT …] [CHECK …] [REFERENCES …]` or null (M2M). */
  columnSql(model: ModelClass, field: Field<any, any>, opts: { default?: string } = {}): string | null {
    const type = this.columnType(field)
    if (!type || !field.concrete) return null
    const parts = [this.quoteName(field.column), type]
    parts.push(field.null && !field.primaryKey ? 'NULL' : 'NOT NULL')
    if (field.primaryKey) {
      parts.push('PRIMARY KEY')
      if (field.isAutoField) parts.push(this.autoFieldSql(field))
    } else if (field.unique) parts.push('UNIQUE')
    const def = opts.default ?? this.defaultSql(field)
    if (def) parts.push(def)
    const check = field.dbCheck(this.dialect)
    if (check) parts.push(`CHECK (${check})`)
    if (field instanceof ForeignKey && field.dbConstraint) {
      const ref = this.inlineForeignKeySql(model, field)
      if (ref) parts.push(ref)
    }
    return parts.filter(Boolean).join(' ')
  }

  /** CREATE TABLE statement (without indexes). */
  tableSql(model: ModelClass): string {
    return this.tableSqlFor(this.tableDefinition(model))
  }

  protected tableSqlFor(def: TableDefinition, table = def.table): string {
    const defs: string[] = []
    for (const f of def.fields) {
      const col = this.columnSql(def.model, f)
      if (col) defs.push(col)
    }
    for (const c of def.checks) defs.push(`CONSTRAINT ${this.quoteName(c.name)} CHECK (${c.check})`)
    return `CREATE TABLE ${this.quoteName(table)} (${defs.join(', ')})`
  }

  /** The full definition of a model's table (columns, checks, indexes, unique sets). */
  tableDefinition(model: ModelClass): TableDefinition {
    const meta = model._meta
    return {
      model,
      table: meta.dbTable,
      fields: meta.concreteFields.filter((f) => this.columnType(f) !== null),
      checks: meta.constraints.filter(
        (c): c is Extract<ConstraintSpec, { type: 'check' }> => c.type === 'check',
      ),
      indexes: this.modelIndexes(model),
      uniques: this.modelUniqueConstraints(model),
    }
  }

  /** Literal SQL for a value of `field` (after `toDb`). */
  valueLiteral(field: Field<any, any>, value: unknown): string {
    const v = field.toDb(value as any, this.dialect)
    if (v instanceof Uint8Array) {
      const hex = [...v].map((b) => b.toString(16).padStart(2, '0')).join('')
      return this.dialect === 'postgresql' ? `'\\x${hex}'::bytea` : `X'${hex}'`
    }
    return literal(v, this.dialect)
  }

  /**
   * Value used to fill existing rows when a column is added or made NOT NULL (Django's
   * `effective_default`): an explicit one-off default, the field's default (callables are called once),
   * "now" for `autoNow`/`autoNowAdd` fields, `''` for blank string fields; otherwise `NO_DEFAULT`.
   */
  effectiveDefault(field: Field<any, any>, explicit?: BackfillOption): unknown {
    if (explicit && explicit.default !== undefined) return explicit.default
    if (field.hasDefault()) {
      const d = field.options.default
      return typeof d === 'function' ? (d as () => unknown)() : d
    }
    const f = field as Field<any, any> & { autoNow?: boolean; autoNowAdd?: boolean }
    if (f.autoNow || f.autoNowAdd) return f.preSave({} as any, true)
    if (!field.null && field.blank && field.emptyStringsAllowed) return ''
    return NO_DEFAULT
  }

  // ---- indexes & constraints --------------------------------------------------------------------

  protected columnsFor(model: ModelClass, names: string[]): string[] {
    return names.map((n) => {
      const desc = n.startsWith('-')
      const name = desc ? n.slice(1) : n
      const f = model._meta.getForwardField(name)
      if (!f?.concrete)
        throw new NotSupportedError(
          `Index/constraint field '${name}' is not a concrete field of ${model._meta.objectName}.`,
        )
      return desc ? `${this.quoteName(f.column)} DESC` : this.quoteName(f.column)
    })
  }

  indexName(model: ModelClass, index: IndexSpec): string {
    if (index.name) return index.name
    const cols = index.fields.map((n) => model._meta.getForwardField(n.replace(/^-/, ''))?.column ?? n)
    return this.createName(model._meta.dbTable, cols, index.unique ? '_uniq' : '_idx')
  }

  createIndexSql(model: ModelClass, index: IndexSpec, table = model._meta.dbTable): string {
    const cols = this.columnsFor(model, index.fields)
    const where = index.condition ? ` WHERE ${index.condition}` : ''
    return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${this.quoteName(this.indexName(model, index))} ON ${this.quoteName(table)} (${cols.join(', ')})${where}`
  }

  /** Index implied by a field (`dbIndex`, ForeignKey), or null. */
  fieldIndex(field: Field<any, any>): IndexSpec | null {
    if (!field.concrete || !field.dbIndex || field.unique || field.primaryKey) return null
    if (this.columnType(field) === null) return null
    return { fields: [field.name] }
  }

  /** Indexes implied by fields (`dbIndex`, ForeignKey) and Meta.indexes. */
  modelIndexes(model: ModelClass): IndexSpec[] {
    const meta = model._meta
    const out: IndexSpec[] = []
    for (const f of meta.concreteFields) {
      const idx = this.fieldIndex(f)
      if (idx) out.push(idx)
    }
    out.push(...meta.indexes)
    return out
  }

  /** Name of the unique set `fields` of `model` (Meta.uniqueTogether naming). */
  uniqueTogetherName(model: ModelClass, fields: string[]): string {
    const meta = model._meta
    const cols = fields.map((n) => meta.getForwardField(n)?.column ?? n)
    return this.createName(meta.dbTable, cols, '_uniq')
  }

  /** Unique sets from Meta.uniqueTogether and unique constraints. */
  modelUniqueConstraints(model: ModelClass): UniqueSpec[] {
    const meta = model._meta
    const out: UniqueSpec[] = []
    for (const ut of meta.uniqueTogether) out.push({ fields: ut, name: this.uniqueTogetherName(model, ut) })
    for (const c of meta.constraints)
      if (c.type === 'unique') out.push({ fields: c.fields, name: c.name, condition: c.condition })
    return out
  }

  abstract createUniqueSql(model: ModelClass, u: UniqueSpec, table?: string): string
  abstract deleteUniqueSql(model: ModelClass, name: string): string

  // ---- operations: models -----------------------------------------------------------------------

  /** CREATE TABLE + indexes + unique constraints + auto-created M2M tables. */
  async createModel(model: ModelClass): Promise<void> {
    await this.execute(this.tableSql(model))
    for (const idx of this.modelIndexes(model)) await this.execute(this.createIndexSql(model, idx))
    for (const u of this.modelUniqueConstraints(model)) await this.execute(this.createUniqueSql(model, u))
    this.queueForeignKeys(model)
    for (const m2m of model._meta.localManyToMany) {
      const through = m2m.through
      if (through._meta.autoCreated) await this.createModel(through)
    }
  }

  /** Queue deferred FK constraints (PostgreSQL). */
  protected queueForeignKeys(_model: ModelClass): void {}

  async deleteModel(model: ModelClass): Promise<void> {
    for (const m2m of model._meta.localManyToMany) {
      const through = m2m.through
      if (through._meta.autoCreated) await this.deleteModel(through)
    }
    await this.execute(this.deleteTableSql(model._meta.dbTable))
  }

  protected deleteTableSql(table: string): string {
    return `DROP TABLE ${this.quoteName(table)}`
  }

  async addIndex(model: ModelClass, index: IndexSpec): Promise<void> {
    await this.execute(this.createIndexSql(model, index))
  }

  async removeIndex(model: ModelClass, index: IndexSpec): Promise<void> {
    await this.execute(`DROP INDEX ${this.quoteName(this.indexName(model, index))}`)
  }

  async addConstraint(model: ModelClass, c: ConstraintSpec): Promise<void> {
    if (c.type === 'unique') await this.execute(this.createUniqueSql(model, c))
    else await this.addCheckConstraint(model, c)
  }

  async removeConstraint(model: ModelClass, c: ConstraintSpec): Promise<void> {
    if (c.type === 'unique') await this.execute(this.deleteUniqueSql(model, c.name))
    else await this.removeCheckConstraint(model, c)
  }

  protected abstract addCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void>
  protected abstract removeCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void>

  /** Rename a table (AlterModelTable / RenameModel). */
  async alterDbTable(_model: ModelClass, oldTable: string, newTable: string): Promise<void> {
    if (oldTable === newTable) return
    await this.execute(`ALTER TABLE ${this.quoteName(oldTable)} RENAME TO ${this.quoteName(newTable)}`)
  }

  /**
   * Change Meta.uniqueTogether from `oldSets` to `newSets` (field names). `model` is the to-state model;
   * pass `oldModel` when columns were renamed in between.
   */
  async alterUniqueTogether(
    model: ModelClass,
    oldSets: string[][],
    newSets: string[][],
    oldModel: ModelClass = model,
  ): Promise<void> {
    const key = (s: string[]) => JSON.stringify(s)
    const oldKeys = new Set(oldSets.map(key))
    const newKeys = new Set(newSets.map(key))
    for (const s of oldSets) {
      if (newKeys.has(key(s))) continue
      const cols = s.map((n) => oldModel._meta.getForwardField(n)?.column ?? n)
      const name =
        (await this.findUniqueName(oldModel._meta.dbTable, cols)) ?? this.uniqueTogetherName(oldModel, s)
      await this.execute(this.deleteUniqueSql(oldModel, name))
    }
    for (const s of newSets) {
      if (oldKeys.has(key(s))) continue
      await this.execute(this.createUniqueSql(model, { fields: s, name: this.uniqueTogetherName(model, s) }))
    }
  }

  // ---- operations: fields -----------------------------------------------------------------------

  /**
   * Add `field` (bound to the to-state `model`) to the table. Existing rows get the field's effective
   * default or `opts.default` (one-off value from makemigrations).
   */
  async addField(model: ModelClass, field: Field<any, any>, opts: BackfillOption = {}): Promise<void> {
    if (field instanceof ManyToManyField) {
      if (field.through._meta.autoCreated) await this.createModel(field.through)
      return
    }
    await this.addColumn(model, field, opts)
  }

  /** Remove `field` (bound to the from-state `model`) from the table. */
  async removeField(model: ModelClass, field: Field<any, any>, opts: RemoveFieldOptions = {}): Promise<void> {
    if (field instanceof ManyToManyField) {
      if (field.through._meta.autoCreated) await this.deleteModel(field.through)
      return
    }
    if (this.columnType(field) === null) return
    await this.dropColumn(model, field, opts)
  }

  /**
   * Change a field: `oldField` is bound to the from-state model, `newField` to the to-state `model`.
   * Handles renamed columns, type / null / default / unique / index / FK changes and M2M table renames.
   */
  async alterField(
    model: ModelClass,
    oldField: Field<any, any>,
    newField: Field<any, any>,
    opts: AlterFieldOptions = {},
  ): Promise<void> {
    const oldM2M = oldField instanceof ManyToManyField
    const newM2M = newField instanceof ManyToManyField
    if (oldM2M && newM2M) {
      await this.alterManyToMany(model, oldField as ManyToManyField, newField as ManyToManyField)
      return
    }
    if (oldM2M || newM2M) {
      throw new NotSupportedError(
        `Cannot alter field ${model._meta.objectName}.${newField.name} between a many-to-many and a concrete field; ` +
          'remove the old field and add the new one instead.',
      )
    }
    const oldType = this.columnType(oldField)
    const newType = this.columnType(newField)
    if (oldType === null && newType === null) return
    if (oldType === null || newType === null) {
      throw new NotSupportedError(
        `Cannot alter field ${model._meta.objectName}.${newField.name}: one of the definitions has no column type.`,
      )
    }
    await this.alterColumn(model, oldField, newField, opts)
  }

  /** M2M → M2M: rename the auto-created through table and its columns, or alter its FKs. */
  protected async alterManyToMany(
    model: ModelClass,
    oldField: ManyToManyField,
    newField: ManyToManyField,
  ): Promise<void> {
    const oldThrough = oldField.through
    const newThrough = newField.through
    if (!oldThrough._meta.autoCreated || !newThrough._meta.autoCreated) return
    const oldTable = oldThrough._meta.dbTable
    const newTable = newThrough._meta.dbTable
    if (oldTable !== newTable) await this.alterDbTable(newThrough, oldTable, newTable)
    const [oldFrom, oldTo] = oldField.throughFieldNames()
    const [newFrom, newTo] = newField.throughFieldNames()
    for (const [o, n] of [
      [oldFrom, newFrom],
      [oldTo, newTo],
    ] as const) {
      const of = oldThrough._meta.getForwardField(o)!
      const nf = newThrough._meta.getForwardField(n)!
      await this.alterField(newThrough, of, nf, { oldModel: oldThrough })
    }
    void model
  }

  protected abstract addColumn(model: ModelClass, field: Field<any, any>, opts: BackfillOption): Promise<void>
  protected abstract dropColumn(
    model: ModelClass,
    field: Field<any, any>,
    opts: RemoveFieldOptions,
  ): Promise<void>
  protected abstract alterColumn(
    model: ModelClass,
    oldField: Field<any, any>,
    newField: Field<any, any>,
    opts: AlterFieldOptions,
  ): Promise<void>

  /** Rename a column in place. */
  async renameColumn(table: string, oldColumn: string, newColumn: string): Promise<void> {
    if (oldColumn === newColumn) return
    await this.execute(
      `ALTER TABLE ${this.quoteName(table)} RENAME COLUMN ${this.quoteName(oldColumn)} TO ${this.quoteName(newColumn)}`,
    )
  }

  /** RenameField: same as alterField (the column follows the field's name unless `dbColumn`). */
  async renameField(model: ModelClass, oldField: Field<any, any>, newField: Field<any, any>): Promise<void> {
    await this.alterField(model, oldField, newField)
  }

  /** RenameModel: rename the table (M2M through tables are handled by the operation via alterField). */
  async renameModel(oldModel: ModelClass, newModel: ModelClass): Promise<void> {
    await this.alterDbTable(newModel, oldModel._meta.dbTable, newModel._meta.dbTable)
  }

  // ---- introspection ----------------------------------------------------------------------------

  abstract tableNames(): Promise<string[]>
  abstract columnNames(table: string): Promise<string[]>
  /** Name of a unique constraint / unique index on exactly `columns`, or null (collect-only: null). */
  abstract findUniqueName(table: string, columns: string[]): Promise<string | null>
}

/** Does an index / unique / constraint spec mention a field name? */
export function specMentions(fields: string[], name: string): boolean {
  return fields.some((f) => f.replace(/^-/, '') === name)
}
