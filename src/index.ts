// @ghuri/orm — Django-style models, QuerySets and DB adapters on Drizzle. See ARCHITECTURE.md §5.
// Workers-safe: no Node-only imports in this entry's graph (better-sqlite3 / PGlite live in subpaths,
// postgres.js is imported dynamically).
import './models/relations'
import './drizzle'

export type { ModelClass, ModelMeta, ModelState, FieldMap, IndexSpec, ConstraintSpec } from './models/types'
export {
  BaseModel,
  Model,
  createModelClass,
  registerModels,
  isAbstractModel,
  type Related,
  type ModelFields,
  type ModelInit,
  type ModelBaseClass,
  type SaveOptions,
  type FullCleanOptions,
} from './models/base'
export { Options } from './models/options'
export { ModelRegistry, modelRegistry, isModelClass } from './models/registry'
export { Manager, type InstanceOf } from './models/manager'
export { RelatedManager, ManyRelatedManager } from './models/related-managers'
export { RelatedRef } from './models/descriptors'
export { Collector } from './models/deletion'

export * from './fields/index'
export * from './validators'

export { QuerySet, type FilterArg, type CreateData, type AggregateSpec, type ValuesListOptions, type BulkCreateOptions } from './query/queryset'
export { Prefetch, prefetchRelatedObjects } from './query/prefetch'
export {
  F,
  Q,
  QNode,
  Value,
  Count,
  Sum,
  Avg,
  Min,
  Max,
  Aggregate,
  Expression,
  FExpression,
  ValueExpression,
  CombinedExpression,
  OrderBy,
  RawSQL,
  Func,
  Lower,
  Upper,
  Length,
  Coalesce,
  Concat,
  Now,
  type AggregateOptions,
  type OrderByOptions,
} from './query/expressions'
export { LOOKUPS, TRANSFORMS } from './query/compiler'

export {
  preSave,
  postSave,
  preDelete,
  postDelete,
  m2mChanged,
  type SaveSignalArgs,
  type PostSaveSignalArgs,
  type DeleteSignalArgs,
  type M2MChangedArgs,
  type M2MAction,
} from './signals'

export {
  FieldError,
  FieldDoesNotExist,
  DatabaseError,
  IntegrityError,
  NotSupportedError,
  TransactionManagementError,
  ProtectedError,
  RestrictedError,
} from './errors'

export type { Connection, DatabaseConfig, DatabaseFeatures, ExecuteResult, Vendor, Dialect } from './db/types'
export { connections, atomic, onCommit, getDrizzle, getDatabaseConfig, DEFAULT_DB_ALIAS } from './db/connections'
export { BaseConnection, onQuery, captureQueries, type QueryEvent } from './db/base'
export { d1, D1Connection, type D1DatabaseLike } from './db/d1'
export { postgres, PostgresJsConnection, type PostgresOptions } from './db/postgres'

export { getTable, getSchema } from './drizzle'
export { getObjectOr404, getListOr404 } from './shortcuts'
