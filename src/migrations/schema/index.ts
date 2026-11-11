import type { Dialect } from '../../query/sql'
import {
  type AlterFieldOptions,
  type BackfillOption,
  BaseSchemaEditor,
  NO_DEFAULT,
  type RemoveFieldOptions,
  type SchemaConnection,
  type SchemaEditorOptions,
  type TableDefinition,
  type UniqueSpec,
} from './base'
import { PostgresSchemaEditor } from './postgresql'
import { SqliteSchemaEditor } from './sqlite'

export type {
  AlterFieldOptions,
  BackfillOption,
  RemoveFieldOptions,
  SchemaConnection,
  SchemaEditorOptions,
  TableDefinition,
  UniqueSpec,
}
export { BaseSchemaEditor, NO_DEFAULT, PostgresSchemaEditor, SqliteSchemaEditor }

/** The schema editor for a connection's (or a bare) dialect. */
export function schemaEditorFor(
  connection: SchemaConnection | { dialect: Dialect } | Dialect,
  options: SchemaEditorOptions = {},
): BaseSchemaEditor {
  const dialect = typeof connection === 'string' ? connection : connection.dialect
  const conn =
    typeof connection === 'string' || !('execute' in connection) ? null : (connection as SchemaConnection)
  const opts = conn ? options : { ...options, collectOnly: true }
  return dialect === 'postgresql' ? new PostgresSchemaEditor(conn, opts) : new SqliteSchemaEditor(conn, opts)
}
