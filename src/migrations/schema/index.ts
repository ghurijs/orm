import type { Dialect } from '../../query/sql'
import { BaseSchemaEditor, type SchemaConnection, type SchemaEditorOptions } from './base'
import { PostgresSchemaEditor } from './postgresql'
import { SqliteSchemaEditor } from './sqlite'

export type { SchemaConnection, SchemaEditorOptions }
export { BaseSchemaEditor, PostgresSchemaEditor, SqliteSchemaEditor }

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
