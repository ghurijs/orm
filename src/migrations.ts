// @ghuri/orm/migrations — Django-style migrations: Migration + operations (used by migration files), project
// state, loader, executor, recorder, autodetector, writer, schema editors and the programmatic API.
// Workers-safe: file access lives in @ghuri/orm/commands (Node).
import './models/relations'
import './drizzle'

export {
  type CopyDataOptions,
  copyData,
  type DumpDataOptions,
  dumpData,
  type FixtureObject,
  type FlushOptions,
  flushDatabase,
  type LoadDataOptions,
  type LoadDataResult,
  loadData,
  resetSequences,
  sortModelsByDependencies,
} from './data'
export { DB_TYPES, dbTypeFor, type FieldDeconstruction, registerDbType } from './fields/base'
export { fieldFromSpec, getFieldClass, registerFieldClass } from './fields/index'
export {
  type GeneratedMigration,
  getMigrationFileSystem,
  type MakeMigrationsOptions,
  type MakeMigrationsResult,
  type MigrateOptions,
  type MigrateResult,
  type MigrationFileSystem,
  type MigrationStatus,
  makeMigrations,
  migrate,
  type ShowMigrationsOptions,
  type SqlMigrateAllOptions,
  type SqlMigrateOptions,
  type SqlMigrationFile,
  setMigrationFileSystem,
  showMigrations,
  sqlMigrate,
  sqlMigrateAll,
} from './migrations/api'
export {
  type AutodetectorChangesOptions,
  IGNORE,
  MigrationAutodetector,
  type MigrationQuestioner,
  NonInteractiveQuestioner,
} from './migrations/autodetector'
export {
  InconsistentMigrationHistory,
  InvalidMigrationPlan,
  IrreversibleError,
  MigrationConflictError,
  MigrationError,
  MigrationQuestionError,
  NodeNotFoundError,
} from './migrations/errors'
export {
  type MigrateRunOptions,
  MigrationExecutor,
  type MigrationPlanEntry,
  type MigrationTarget,
  type ProgressEvent,
} from './migrations/executor'
export { MigrationGraph } from './migrations/graph'
export {
  getMigrationDiskLoader,
  MigrationLoader,
  type MigrationLoaderOptions,
  type MigrationSourceLoader,
  migrationsFromModule,
  setMigrationDiskLoader,
} from './migrations/loader'
export { isMigration, Migration, type MigrationKey, type MigrationOptions } from './migrations/migration'
export {
  AddConstraint,
  AddField,
  type AddFieldOptions,
  AddIndex,
  AlterField,
  type AlterFieldOptions,
  AlterModelOptions,
  AlterModelTable,
  AlterUniqueTogether,
  CreateModel,
  type CreateModelOptions,
  DeleteModel,
  isOperation,
  Operation,
  operations,
  RemoveConstraint,
  RemoveField,
  RemoveIndex,
  RenameField,
  RenameModel,
  RunCode,
  type RunCodeFn,
  RunSQL,
  type RunSQLOptions,
  type SchemaContext,
  type SqlInput,
} from './migrations/operations'
export { InteractiveQuestioner, parseDefaultAnswer } from './migrations/questioner'
export { type AppliedMigration, MigrationRecorder } from './migrations/recorder'
export {
  type AlterFieldOptions as SchemaAlterFieldOptions,
  BaseSchemaEditor,
  PostgresSchemaEditor,
  type SchemaConnection,
  type SchemaEditorOptions,
  SqliteSchemaEditor,
  schemaEditorFor,
} from './migrations/schema/index'
export {
  canonicalJson,
  type FieldSpec,
  flattenFieldSpec,
  ModelState,
  normalizeFieldSpec,
  ProjectState,
  StateApps,
} from './migrations/state'
export {
  MigrationWriter,
  type MigrationWriterOptions,
  migrationExportName,
  migrationsIndexSource,
  serializeOperation,
  serializeValue,
} from './migrations/writer'
export { createModelClass, registerModels } from './models/base'
export { ModelRegistry, modelRegistry } from './models/registry'
export { type Dialect, ident, literal, quoteName, Sql, sql } from './query/sql'
