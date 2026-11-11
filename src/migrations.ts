// @ghuri/orm/migrations — schema editors and building blocks for the migration system.
import './models/relations'
import './drizzle'

export {
  BaseSchemaEditor,
  PostgresSchemaEditor,
  SqliteSchemaEditor,
  schemaEditorFor,
  type SchemaConnection,
  type SchemaEditorOptions,
} from './migrations/schema/index'
export { createModelClass, registerModels } from './models/base'
export { ModelRegistry, modelRegistry } from './models/registry'
export { DB_TYPES, registerDbType, dbTypeFor, type FieldDeconstruction } from './fields/base'
export { fieldFromSpec, registerFieldClass, getFieldClass } from './fields/index'
export { Sql, sql, ident, literal, quoteName, type Dialect } from './query/sql'
