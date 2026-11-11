import { NotSupportedError } from '../../errors'
import type { Field } from '../../fields/base'
import type { ForeignKey } from '../../fields/related'
import type { ConstraintSpec, ModelClass } from '../../models/types'
import { BaseSchemaEditor } from './base'

/**
 * SQLite / D1 schema editor. Foreign keys are declared inline (`REFERENCES … DEFERRABLE INITIALLY
 * DEFERRED`) because SQLite can't add constraints later; unique sets become unique indexes so they can
 * be dropped without a table rebuild. ALTER operations that SQLite can't express (AlterField, check
 * constraints) need the table-rebuild strategy, added by the migrations module.
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

  createUniqueSql(model: ModelClass, u: { fields: string[]; name: string; condition?: string }): string {
    const cols = this.columnsFor(model, u.fields)
    const where = u.condition ? ` WHERE ${u.condition}` : ''
    return `CREATE UNIQUE INDEX ${this.quoteName(u.name)} ON ${this.quoteName(model._meta.dbTable)} (${cols.join(', ')})${where}`
  }

  deleteUniqueSql(_model: ModelClass, name: string): string {
    return `DROP INDEX ${this.quoteName(name)}`
  }

  protected async addCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void> {
    throw new NotSupportedError(
      `Adding check constraint '${c.name}' to ${model._meta.objectName} requires a SQLite table rebuild.`,
    )
  }

  protected async removeCheckConstraint(
    model: ModelClass,
    c: Extract<ConstraintSpec, { type: 'check' }>,
  ): Promise<void> {
    throw new NotSupportedError(
      `Removing check constraint '${c.name}' from ${model._meta.objectName} requires a SQLite table rebuild.`,
    )
  }

  async renameColumn(table: string, oldColumn: string, newColumn: string): Promise<void> {
    await this.execute(
      `ALTER TABLE ${this.quoteName(table)} RENAME COLUMN ${this.quoteName(oldColumn)} TO ${this.quoteName(newColumn)}`,
    )
  }

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

  /** Column definition helper exposed for the table-rebuild implementation. */
  definitionFor(model: ModelClass, field: Field<any, any>): string | null {
    return this.columnSql(model, field)
  }
}
