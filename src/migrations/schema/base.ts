import { NotSupportedError } from '../../errors'
import type { Field } from '../../fields/base'
import { ForeignKey } from '../../fields/related'
import type { ConstraintSpec, IndexSpec, ModelClass } from '../../models/types'
import { type Dialect, literal, quoteName } from '../../query/sql'
import { shortHash } from '../../utils'

/** What the schema editor needs from a connection (a full `Connection` works). */
export interface SchemaConnection {
  dialect: Dialect
  execute(sql: string, params?: unknown[]): Promise<{ rows?: Record<string, unknown>[] } | unknown>
}

export interface SchemaEditorOptions {
  /** Only collect SQL into `collectedSql` without executing (sqlmigrate). */
  collectOnly?: boolean
}

const MAX_NAME_LENGTH = 63

/**
 * Turns model definitions into DDL. Operates on model classes (`_meta`), so historical models rendered by
 * the migrations state work the same as live models.
 *
 * Structure (Django's `BaseDatabaseSchemaEditor`):
 * - `columnSql()` / `tableSql()` build definitions from `field.dbType(dialect)` (the type map lives in
 *   `fields/base.ts#DB_TYPES`, extendable with `registerDbType`).
 * - `createModel()` / `deleteModel()` handle tables, indexes, unique constraints and auto-created M2M tables.
 * - Statements that must run after every table exists (PostgreSQL foreign keys) go to `deferredSql`,
 *   flushed by `flushDeferred()` / `run()`.
 * - Dialect subclasses override the `sql*` templates and hooks (`columnSqlExtra`, `foreignKeySql`, …).
 */
export abstract class BaseSchemaEditor {
  abstract readonly dialect: Dialect
  readonly collectedSql: string[] = []
  deferredSql: string[] = []

  constructor(
    readonly connection: SchemaConnection | null,
    readonly options: SchemaEditorOptions = {},
  ) {}

  /** Run `fn` with this editor and flush deferred SQL at the end (like Django's `with schema_editor()`). */
  async run<T>(fn: (editor: this) => Promise<T>): Promise<T> {
    const r = await fn(this)
    await this.flushDeferred()
    return r
  }

  async flushDeferred(): Promise<void> {
    const pending = this.deferredSql
    this.deferredSql = []
    for (const s of pending) await this.execute(s)
  }

  quoteName(name: string): string {
    return quoteName(name)
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.collectedSql.push(params.length ? `${sql} -- params: ${JSON.stringify(params)}` : `${sql};`)
    if (this.options.collectOnly || !this.connection) return
    await this.connection.execute(sql, params)
  }

  /** Run a read query for introspection (always executed). */
  protected async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (!this.connection) return []
    const res = (await this.connection.execute(sql, params)) as { rows?: Record<string, unknown>[] }
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
  columnSql(model: ModelClass, field: Field<any, any>): string | null {
    const type = this.columnType(field)
    if (!type || !field.concrete) return null
    const parts = [this.quoteName(field.column), type]
    parts.push(field.null && !field.primaryKey ? 'NULL' : 'NOT NULL')
    if (field.primaryKey) {
      parts.push('PRIMARY KEY')
      if (field.isAutoField) parts.push(this.autoFieldSql(field))
    } else if (field.unique) parts.push('UNIQUE')
    const def = this.defaultSql(field)
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
    const meta = model._meta
    const defs: string[] = []
    for (const f of meta.concreteFields) {
      const col = this.columnSql(model, f)
      if (col) defs.push(col)
    }
    for (const c of meta.constraints) {
      if (c.type === 'check') defs.push(`CONSTRAINT ${this.quoteName(c.name)} CHECK (${c.check})`)
    }
    return `CREATE TABLE ${this.quoteName(meta.dbTable)} (${defs.join(', ')})`
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

  createIndexSql(model: ModelClass, index: IndexSpec): string {
    const cols = this.columnsFor(model, index.fields)
    const where = index.condition ? ` WHERE ${index.condition}` : ''
    return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${this.quoteName(this.indexName(model, index))} ON ${this.quoteName(model._meta.dbTable)} (${cols.join(', ')})${where}`
  }

  /** Indexes implied by fields (`dbIndex`, ForeignKey) and Meta.indexes. */
  modelIndexes(model: ModelClass): IndexSpec[] {
    const meta = model._meta
    const out: IndexSpec[] = []
    for (const f of meta.concreteFields) {
      if (f.dbIndex && !f.unique && !f.primaryKey) out.push({ fields: [f.name] })
    }
    out.push(...meta.indexes)
    return out
  }

  /** Unique sets from Meta.uniqueTogether and unique constraints. */
  modelUniqueConstraints(model: ModelClass): Array<{ fields: string[]; name: string; condition?: string }> {
    const meta = model._meta
    const out: Array<{ fields: string[]; name: string; condition?: string }> = []
    for (const ut of meta.uniqueTogether) {
      const cols = ut.map((n) => meta.getForwardField(n)?.column ?? n)
      out.push({ fields: ut, name: this.createName(meta.dbTable, cols, '_uniq') })
    }
    for (const c of meta.constraints)
      if (c.type === 'unique') out.push({ fields: c.fields, name: c.name, condition: c.condition })
    return out
  }

  abstract createUniqueSql(
    model: ModelClass,
    u: { fields: string[]; name: string; condition?: string },
  ): string
  abstract deleteUniqueSql(model: ModelClass, name: string): string

  // ---- operations -------------------------------------------------------------------------------

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

  async alterDbTable(_model: ModelClass, oldTable: string, newTable: string): Promise<void> {
    if (oldTable === newTable) return
    await this.execute(`ALTER TABLE ${this.quoteName(oldTable)} RENAME TO ${this.quoteName(newTable)}`)
  }

  // Field-level operations are implemented by the migrations package (AddField/AlterField/RenameField and the
  // SQLite table rebuild). The hooks are declared here so the dialect editors have a single place to extend.
  async addField(model: ModelClass, field: Field<any, any>): Promise<void> {
    throw new NotSupportedError(
      `addField(${model._meta.objectName}.${field.name}) is not implemented by this schema editor yet.`,
    )
  }
  async removeField(model: ModelClass, field: Field<any, any>): Promise<void> {
    throw new NotSupportedError(
      `removeField(${model._meta.objectName}.${field.name}) is not implemented by this schema editor yet.`,
    )
  }
  async alterField(model: ModelClass, oldField: Field<any, any>, _newField: Field<any, any>): Promise<void> {
    throw new NotSupportedError(
      `alterField(${model._meta.objectName}.${oldField.name}) is not implemented by this schema editor yet.`,
    )
  }

  // ---- introspection ----------------------------------------------------------------------------

  abstract tableNames(): Promise<string[]>
  abstract columnNames(table: string): Promise<string[]>
}
