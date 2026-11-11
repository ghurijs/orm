import type { MultipleObjectsReturned, ObjectDoesNotExist } from '@ghuri/core'
import type { Field } from '../fields/base'
import type { Dialect } from '../query/sql'
import type { BaseModel } from './base'
import type { Manager } from './manager'
import type { Options } from './options'

export type { BaseModel }

/**
 * Field map passed to `Model({...})`. The option type is deliberately not `any`: contextual typing would
 * otherwise infer `O = any` for `new IntegerField()` and break `null`/`primaryKey` inference.
 */
export type FieldMap = Record<string, Field<any, object>>

export interface IndexSpec {
  fields: string[]
  name?: string
  unique?: boolean
  /** Raw SQL WHERE clause for partial indexes (both dialects support it). */
  condition?: string
}

export type ConstraintSpec =
  | { type: 'unique'; fields: string[]; name: string; condition?: string }
  | { type: 'check'; check: string; name: string }

export interface ModelMeta {
  abstract?: boolean
  appLabel?: string
  dbTable?: string
  ordering?: string[]
  verboseName?: string
  verboseNamePlural?: string
  uniqueTogether?: string[] | string[][]
  indexes?: IndexSpec[]
  constraints?: ConstraintSpec[]
  permissions?: Array<[string, string]>
  defaultPermissions?: string[]
  getLatestBy?: string | string[]
  /** Model is managed by migrations (default true). */
  managed?: boolean
  /** Name of the default manager attribute (default: first manager, normally `objects`). */
  defaultManagerName?: string
  /** Internal: set for auto-created M2M through models. */
  autoCreated?: boolean
  [key: string]: unknown
}

export interface ModelState {
  adding: boolean
  db: string | undefined
  /** Cached related objects (FK forward, reverse one-to-one). */
  fieldsCache: Map<string, unknown>
  /** Prefetched reverse/M2M results keyed by accessor name. */
  prefetched: Map<string, BaseModel[]>
  /** Fields not loaded because of only()/defer(). */
  deferred: Set<string>
  /** Annotation names set on this instance. */
  annotations: Set<string>
}

/** Static side of every model class. */
export interface ModelClass<T extends BaseModel = BaseModel> {
  new (data?: any): T
  readonly prototype: T
  readonly name: string
  readonly _meta: Options
  objects: Manager<T>
  readonly _defaultManager: Manager<T>
  readonly _baseManager: Manager<T>
  fields: FieldMap
  Meta?: ModelMeta
  DoesNotExist: new (message?: string) => ObjectDoesNotExist
  MultipleObjectsReturned: new (message?: string) => MultipleObjectsReturned
  table(dialect?: Dialect): any
  fromRow(row: Record<string, unknown>, dialect?: Dialect): T
}
