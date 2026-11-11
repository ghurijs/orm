// @ghuri/orm — Django-style models, QuerySets and DB adapters on Drizzle. See ARCHITECTURE.md §5.
// Workers-safe: no Node-only imports in this entry's graph (better-sqlite3 / PGlite live in subpaths,
// postgres.js is imported dynamically).
import './models/relations'
import './drizzle'

export { BaseConnection, captureQueries, onQuery, type QueryEvent } from './db/base'
export {
  atomic,
  connections,
  DEFAULT_DB_ALIAS,
  getDatabaseConfig,
  getDrizzle,
  onCommit,
} from './db/connections'
export { D1Connection, type D1DatabaseLike, d1 } from './db/d1'
export { PostgresJsConnection, type PostgresOptions, postgres } from './db/postgres'
export type { Connection, DatabaseConfig, DatabaseFeatures, Dialect, ExecuteResult, Vendor } from './db/types'
export { getSchema, getTable } from './drizzle'
export {
  DatabaseError,
  FieldDoesNotExist,
  FieldError,
  IntegrityError,
  NotSupportedError,
  ProtectedError,
  RestrictedError,
  TransactionManagementError,
} from './errors'
export * from './fields/index'
export {
  BaseModel,
  createModelClass,
  type FullCleanOptions,
  isAbstractModel,
  Model,
  type ModelBaseClass,
  type ModelFields,
  type ModelInit,
  type Related,
  registerModels,
  type SaveOptions,
} from './models/base'
export { Collector } from './models/deletion'
export { RelatedRef } from './models/descriptors'
export { type InstanceOf, Manager } from './models/manager'
export { Options } from './models/options'
export { isModelClass, ModelRegistry, modelRegistry } from './models/registry'
export { ManyRelatedManager, RelatedManager } from './models/related-managers'
export type { ConstraintSpec, FieldMap, IndexSpec, ModelClass, ModelMeta, ModelState } from './models/types'
export { LOOKUPS, TRANSFORMS } from './query/compiler'
export {
  Aggregate,
  type AggregateOptions,
  Avg,
  Coalesce,
  CombinedExpression,
  Concat,
  Count,
  Expression,
  F,
  FExpression,
  Func,
  Length,
  Lower,
  Max,
  Min,
  Now,
  OrderBy,
  type OrderByOptions,
  Q,
  QNode,
  RawSQL,
  Sum,
  Upper,
  Value,
  ValueExpression,
} from './query/expressions'
export { Prefetch, prefetchRelatedObjects } from './query/prefetch'
export {
  type AggregateSpec,
  type BulkCreateOptions,
  type CreateData,
  type FilterArg,
  QuerySet,
  type ValuesListOptions,
} from './query/queryset'
export { getListOr404, getObjectOr404 } from './shortcuts'
export {
  type DeleteSignalArgs,
  type M2MAction,
  type M2MChangedArgs,
  type MigrateSignalArgs,
  m2mChanged,
  type PostSaveSignalArgs,
  postDelete,
  postMigrate,
  postSave,
  preDelete,
  preMigrate,
  preSave,
  type SaveSignalArgs,
} from './signals'
export * from './validators'
