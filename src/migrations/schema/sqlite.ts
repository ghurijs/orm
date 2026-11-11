import type { Field } from '../../fields/base'
import { ForeignKey } from '../../fields/related'
import type { ConstraintSpec, ModelClass } from '../../models/types'
import {
  type AlterFieldOptions,
  type BackfillOption,
  BaseSchemaEditor,
  NO_DEFAULT,
  type RemoveFieldOptions,
  specMentions,
  type TableDefinition,
  type UniqueSpec,
} from './base'

/**
 * SQLite / D1 schema editor. Foreign keys are declared inline (`REFERENCES … DEFERRABLE INITIALLY
 * DEFERRED`) because SQLite can't add constraints later; unique sets become unique indexes so they can
 * be dropped without a table rebuild.
 *
 * Changes SQLite can't express with ALTER TABLE (changing a column, adding a unique / NOT NULL / FK
 * column, check constraints) use Django's table-rebuild strategy, adapted so it works on D1 where
 * `PRAGMA foreign_keys` can't be turned off:
 *
 * ```sql
 * PRAGMA defer_foreign_keys = ON;
 * CREATE TABLE "t__ghuri_old" AS SELECT * FROM "t";   -- stash the rows
 * DROP TABLE "t";                                      -- referencing rows become (deferred) violations…
 * CREATE TABLE "t" (…new definition…);
 * INSERT INTO "t" (…) SELECT … FROM "t__ghuri_old";    -- …which re-inserting the rows resolves
 * DROP TABLE "t__ghuri_old";
 * CREATE INDEX …;                                      -- indexes and unique sets of the new definition
 * ```
 *
 * It must run inside a transaction (migrations are atomic: a transaction on SQLite, one `batch()` on D1);
 * outside one, the editor wraps the rebuild in a savepoint.
 */
export class SqliteSchemaEditor extends BaseSchemaEditor {
  readonly dialect = 'sqlite' as const

  protected autoFieldSql(): string {
    return 'AUTOINCREMENT'
  }

  protected inlineForeignKeySql(_model: ModelClass, field: ForeignKey): string | null {
    const target = field.relatedModel
    return `REFERENCES ${this.quoteName(target._meta.dbTable)} (${this.quoteName(field.targetField.column)}) DEFERRABLE INITIALLY DEFERRED`
  }

  createUniqueSql(model: ModelClass, u: UniqueSpec, table = model._meta.dbTable): string {
    const cols = this.columnsFor(model, u.fields)
    const where = u.condition ? ` WHERE ${u.condition}` : ''
    return `CREATE UNIQUE INDEX ${this.quoteName(u.name)} ON ${this.quoteName(table)} (${cols.join(', ')})${where}`
  }

  deleteUniqueSql(_model: ModelClass, name: string): string {
    return `DROP INDEX ${this.quoteName(name)}`
  }

  protected async addCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void> {
    const def = this.tableDefinition(model)
    if (!def.checks.some((x) => x.name === c.name)) def.checks.push(c)
    await this.remakeTable(def, this.identityMapping(def))
  }

  protected async removeCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void> {
    const def = this.tableDefinition(model)
    def.checks = def.checks.filter((x) => x.name !== c.name)
    await this.remakeTable(def, this.identityMapping(def))
  }

  // ---- fields -------------------------------------------------------------------------------------

  protected async addColumn(model: ModelClass, field: Field<any, any>, opts: BackfillOption): Promise<void> {
    const backfill = this.effectiveDefault(field, opts)
    const isFk = field instanceof ForeignKey && field.dbConstraint
    const simple = !field.unique && !field.primaryKey
    // ALTER TABLE ADD COLUMN can't add UNIQUE / PRIMARY KEY columns, NOT NULL without a default, or a
    // REFERENCES column with a non-NULL default.
    if (simple && (backfill === NO_DEFAULT || backfill === null) && field.null) {
      await this.execute(
        `ALTER TABLE ${this.quoteName(model._meta.dbTable)} ADD COLUMN ${this.columnSql(model, field)}`,
      )
    } else if (
      simple &&
      !isFk &&
      backfill !== NO_DEFAULT &&
      backfill !== null &&
      field.dbDefault === undefined
    ) {
      const def = `DEFAULT ${this.valueLiteral(field, backfill)}`
      await this.execute(
        `ALTER TABLE ${this.quoteName(model._meta.dbTable)} ADD COLUMN ${this.columnSql(model, field, { default: def })}`,
      )
    } else {
      const def = this.tableDefinition(model)
      const mapping = this.identityMapping(def, [field.column])
      mapping.set(field.column, backfill === NO_DEFAULT ? 'NULL' : this.valueLiteral(field, backfill))
      await this.remakeTable(def, mapping)
      return
    }
    const idx = this.fieldIndex(field)
    if (idx) await this.execute(this.createIndexSql(model, idx))
  }

  protected async dropColumn(
    model: ModelClass,
    field: Field<any, any>,
    opts: RemoveFieldOptions,
  ): Promise<void> {
    const def = opts.toModel ? this.tableDefinition(opts.toModel) : this.definitionWithout(model, field)
    const current = this.tableDefinition(model)
    const referenced =
      current.indexes.some((i) => specMentions(i.fields, field.name)) ||
      current.uniques.some((u) => specMentions(u.fields, field.name))
    const simple =
      !field.primaryKey &&
      !field.unique &&
      !(field instanceof ForeignKey) &&
      !field.dbCheck(this.dialect) &&
      !referenced
    if (simple) {
      await this.execute(
        `ALTER TABLE ${this.quoteName(model._meta.dbTable)} DROP COLUMN ${this.quoteName(field.column)}`,
      )
      return
    }
    await this.remakeTable(def, this.identityMapping(def, [], current))
  }

  protected async alterColumn(
    model: ModelClass,
    oldField: Field<any, any>,
    newField: Field<any, any>,
    opts: AlterFieldOptions,
  ): Promise<void> {
    const oldModel = opts.oldModel ?? oldField.model ?? model
    const table = model._meta.dbTable
    const oldDef = this.columnSql(oldModel, oldField)?.split(this.quoteName(oldField.column)).join('?')
    const newDef = this.columnSql(model, newField)?.split(this.quoteName(newField.column)).join('?')
    if (oldDef === newDef) {
      // Only the name and/or the plain index may differ: ALTER in place.
      const oldIdx = this.fieldIndex(oldField)
      const newIdx = this.fieldIndex(newField)
      if (oldIdx && (!newIdx || oldField.column !== newField.column))
        await this.execute(`DROP INDEX IF EXISTS ${this.quoteName(this.indexName(oldModel, oldIdx))}`)
      await this.renameColumn(table, oldField.column, newField.column)
      if (newIdx && (!oldIdx || oldField.column !== newField.column))
        await this.execute(this.createIndexSql(model, newIdx))
      return
    }
    const def = this.tableDefinition(model)
    const mapping = this.identityMapping(def, [newField.column])
    let expr = this.quoteName(oldField.column)
    if (oldField.null && !newField.null) {
      const backfill = this.effectiveDefault(newField, opts)
      if (backfill !== NO_DEFAULT && backfill !== null)
        expr = `coalesce(${expr}, ${this.valueLiteral(newField, backfill)})`
    }
    mapping.set(newField.column, expr)
    await this.remakeTable(def, mapping)
  }

  /** `new column → SQL expression over the old table` for columns kept as they are. */
  protected identityMapping(
    def: TableDefinition,
    exclude: string[] = [],
    old?: TableDefinition,
  ): Map<string, string> {
    const m = new Map<string, string>()
    const oldCols = old ? new Set(old.fields.map((f) => f.column)) : null
    for (const f of def.fields) {
      if (exclude.includes(f.column)) continue
      if (oldCols && !oldCols.has(f.column)) continue
      m.set(f.column, this.quoteName(f.column))
    }
    return m
  }

  /** Definition of `model`'s table without `field` (and indexes / unique sets mentioning it). */
  protected definitionWithout(model: ModelClass, field: Field<any, any>): TableDefinition {
    const def = this.tableDefinition(model)
    def.fields = def.fields.filter((f) => f !== field && f.name !== field.name)
    def.indexes = def.indexes.filter((i) => !specMentions(i.fields, field.name))
    def.uniques = def.uniques.filter((u) => !specMentions(u.fields, field.name))
    return def
  }

  /**
   * Rebuild a table with a new definition. `mapping` gives, for each new column, the SQL expression
   * (over the old table) that fills it; columns absent from the mapping get their DEFAULT / NULL.
   */
  async remakeTable(def: TableDefinition, mapping: Map<string, string>): Promise<void> {
    const table = def.table
    const stash = `${table}__ghuri_old`
    const q = (n: string) => this.quoteName(n)
    const savepoint = !this.options.atomic && !this.options.batch && !this.isCollectOnly
    const canSavepoint = savepoint && this.connection?.features?.supportsSavepoints !== false
    if (canSavepoint) await this.execute('SAVEPOINT "ghuri_remake"')
    await this.execute('PRAGMA defer_foreign_keys = ON')
    await this.execute(`CREATE TABLE ${q(stash)} AS SELECT * FROM ${q(table)}`)
    await this.execute(`DROP TABLE ${q(table)}`)
    await this.execute(this.tableSqlFor(def, table))
    const cols = [...mapping.keys()]
    if (cols.length) {
      await this.execute(
        `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) SELECT ${cols.map((c) => mapping.get(c)).join(', ')} FROM ${q(stash)}`,
      )
    }
    await this.execute(`DROP TABLE ${q(stash)}`)
    for (const idx of def.indexes) await this.execute(this.createIndexSql(def.model, idx, table))
    for (const u of def.uniques) await this.execute(this.createUniqueSql(def.model, u, table))
    if (canSavepoint) await this.execute('RELEASE SAVEPOINT "ghuri_remake"')
  }

  // ---- introspection ------------------------------------------------------------------------------

  async tableNames(): Promise<string[]> {
    const rows = await this.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    return rows.map((r) => String(r.name))
  }

  async columnNames(table: string): Promise<string[]> {
    const rows = await this.query(`SELECT name FROM pragma_table_info(?)`, [table])
    return rows.map((r) => String(r.name))
  }

  async findUniqueName(table: string, columns: string[]): Promise<string | null> {
    if (this.isCollectOnly) return null
    const indexes = await this.query(
      `SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin = 'c'`,
      [table],
    )
    for (const idx of indexes) {
      const name = String(idx.name)
      const cols = (await this.query(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, [name])).map(
        (r) => String(r.name),
      )
      if (cols.length === columns.length && cols.every((c, i) => c === columns[i])) return name
    }
    return null
  }

  /** Column definition helper exposed for the table-rebuild implementation. */
  definitionFor(model: ModelClass, field: Field<any, any>): string | null {
    return this.columnSql(model, field)
  }
}
