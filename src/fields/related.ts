import { ValidationError } from '@ghuri/core'
import type { BaseModel, ModelClass } from '../models/types'
import type { Dialect } from '../query/sql'
import { lowerFirst, snakeCase } from '../utils'
import { Field, type FieldOptions, type FormHint } from './base'

// ---- on_delete ----------------------------------------------------------------------------------

export const CASCADE = 'CASCADE' as const
export const PROTECT = 'PROTECT' as const
export const RESTRICT = 'RESTRICT' as const
export const SET_NULL = 'SET_NULL' as const
export const SET_DEFAULT = 'SET_DEFAULT' as const
export const DO_NOTHING = 'DO_NOTHING' as const

export interface SetHandler {
  readonly kind: 'SET'
  readonly value: unknown
}
/** `onDelete: SET(value | () => value)` — Django's `models.SET()`. */
export function SET(value: unknown): SetHandler {
  return Object.freeze({ kind: 'SET', value })
}

export type OnDelete =
  | typeof CASCADE
  | typeof PROTECT
  | typeof RESTRICT
  | typeof SET_NULL
  | typeof SET_DEFAULT
  | typeof DO_NOTHING
  | SetHandler

export function onDeleteName(o: OnDelete): string {
  return typeof o === 'string' ? o : 'SET'
}

// ---- relation targets ---------------------------------------------------------------------------

/** `() => Model` (preferred, avoids import cycles), a Model class, `'app.Model'`, `'Model'` or `'self'`. */
export type RelationTarget<M extends ModelClass = ModelClass> = (() => M) | M | string

type ResolveHook = (field: RelatedField<any, any>) => ModelClass
let resolveHook: ResolveHook = () => {
  throw new Error('Model relations are not initialized')
}
/** Installed by models/relations.ts. */
export function setRelationResolver(fn: ResolveHook): void {
  resolveHook = fn
}

export interface RelatedFieldOptions extends FieldOptions {
  relatedName?: string
  relatedQueryName?: string
  limitChoicesTo?: Record<string, unknown> | (() => Record<string, unknown>)
  /** Create a database FOREIGN KEY constraint (default true). */
  dbConstraint?: boolean
}

/** Common base of ForeignKey, OneToOneField and ManyToManyField. */
export abstract class RelatedField<T = unknown, O extends RelatedFieldOptions = RelatedFieldOptions> extends Field<T, O> {
  override isRelation = true
  readonly to: RelationTarget
  /** Set when the target is resolved. */
  resolvedTarget?: ModelClass
  /** Reverse descriptor info (`Django's remote_field`), set when the target is resolved. */
  remoteField?: RelatedObject
  relatedName?: string
  relatedQueryName?: string
  dbConstraint: boolean

  constructor(to: RelationTarget, options: O) {
    super(options)
    this.to = to
    this.relatedName = options.relatedName
    this.relatedQueryName = options.relatedQueryName
    this.dbConstraint = options.dbConstraint ?? true
  }

  override clone(): this {
    const c = super.clone()
    c.resolvedTarget = undefined
    c.remoteField = undefined
    return c
  }

  /** Target model (resolved lazily from `to`). Throws if it cannot be resolved yet. */
  override get relatedModel(): ModelClass {
    if (!this.resolvedTarget) this.resolvedTarget = resolveHook(this)
    return this.resolvedTarget
  }

  /** Target label for deconstruction (`'auth.User'`) without forcing resolution errors. */
  targetLabel(): string {
    try {
      return this.relatedModel._meta.label
    } catch {
      if (typeof this.to === 'string') return this.to
      return '?'
    }
  }

  get limitChoicesTo(): Record<string, unknown> | undefined {
    const l = this.options.limitChoicesTo
    return typeof l === 'function' ? l() : l
  }

  /** Is the reverse relation hidden (`relatedName` ending with '+')? */
  get reverseHidden(): boolean {
    return (this.relatedName ?? '').endsWith('+')
  }

  protected override deconstructExtra(): Record<string, unknown> {
    const out: Record<string, unknown> = { to: this.targetLabel() }
    if (this.relatedName !== undefined) out.relatedName = this.relatedName
    if (this.relatedQueryName !== undefined) out.relatedQueryName = this.relatedQueryName
    if (this.options.dbConstraint === false) out.dbConstraint = false
    return out
  }
}

// ---- ForeignKey / OneToOneField -----------------------------------------------------------------

export interface ForeignKeyOptions extends RelatedFieldOptions {
  onDelete: OnDelete
  /** Target field (defaults to the target's primary key). */
  toField?: string
}

/**
 * Many-to-one relation. The instance gets `${name}Id` (raw value, column `${name}_id`) and an accessor
 * `${name}` that resolves the related object (`await post.author`).
 */
export class ForeignKey<M extends ModelClass = ModelClass, const O extends ForeignKeyOptions = ForeignKeyOptions> extends RelatedField<
  InstanceType<M>,
  O
> {
  static override readonly internalType: string = 'ForeignKey'
  declare readonly __target: M
  override manyToOne = true
  override emptyStringsAllowed = false
  readonly onDelete: OnDelete
  readonly toField?: string

  constructor(to: RelationTarget<M>, options: O) {
    super(to, { dbIndex: true, ...options } as O)
    this.onDelete = options.onDelete ?? CASCADE
    this.toField = options.toField
    if (this.onDelete === SET_NULL && !this.null) {
      throw new TypeError("Field specifies onDelete=SET_NULL, but cannot be null. Set null: true on the ForeignKey.")
    }
  }

  override getAttname(): string {
    return `${this.name}Id`
  }

  override getColumnName(): string {
    return this.dbColumn ?? `${snakeCase(this.name)}_id`
  }

  /** The field on the target model this FK points to (pk unless `toField`). */
  get targetField(): Field<any, any> {
    const meta = this.relatedModel._meta
    return this.toField ? (meta.getField(this.toField) as Field<any, any>) : meta.pk
  }

  override getDefault(): any {
    const d = super.getDefault()
    if (d && typeof d === 'object' && 'pk' in (d as object)) return (d as unknown as BaseModel).pk
    return d === '' ? null : d
  }

  private rawValue(value: unknown): unknown {
    if (value && typeof value === 'object' && typeof (value as any).constructor?._meta === 'object') {
      return (value as any)[this.targetField.attname]
    }
    return value
  }

  override toPython(value: unknown): any {
    const raw = this.rawValue(value)
    return raw === null || raw === undefined ? raw : this.targetField.toPython(raw)
  }

  override toDb(value: unknown, dialect: Dialect): unknown {
    const raw = this.rawValue(value)
    return raw === null || raw === undefined ? null : this.targetField.toDb(raw, dialect)
  }

  override fromDb(value: unknown, dialect: Dialect): any {
    return value === null || value === undefined ? null : this.targetField.fromDb(value, dialect)
  }

  override getPrepValue(value: unknown): unknown {
    const raw = this.rawValue(value)
    return raw === null || raw === undefined ? raw : this.targetField.getPrepValue(raw)
  }

  override dbType(dialect: Dialect): string | null {
    return this.targetField.dbType(dialect)
  }

  override validate(value: any, instance?: BaseModel): void {
    if (value === null || value === undefined) {
      if (!this.null) throw this.error('null')
      return
    }
    if (this.choices) super.validate(value, instance)
  }

  /** Raw FK value of an instance. */
  override valueFromObject(instance: BaseModel): unknown {
    return (instance as any)[this.attname]
  }

  protected override deconstructExtra(): Record<string, unknown> {
    const out = super.deconstructExtra()
    out.onDelete = onDeleteName(this.onDelete)
    if (typeof this.onDelete === 'object') out.onDeleteValue = this.onDelete.value
    if (this.toField) out.toField = this.toField
    return out
  }

  override formHint(): FormHint {
    let label = '?'
    try {
      label = this.relatedModel._meta.label
    } catch {}
    return this.withHintCommon({ widget: 'select', relatedModel: label, multiple: false, limitChoicesTo: this.limitChoicesTo })
  }

  protected override baseJsonSchema(): Record<string, unknown> {
    let base: Record<string, unknown> = { type: ['integer', 'string'] }
    try {
      const t = this.targetField.jsonSchema()
      base = { type: t.type, ...(t.format ? { format: t.format } : {}) }
      base['x-related-model'] = this.relatedModel._meta.label
    } catch {}
    return base
  }

  override jsonSchema(): Record<string, unknown> {
    const s = super.jsonSchema()
    if (this.null && Array.isArray(s.type) === false && typeof s.type === 'string') s.type = [s.type, 'null']
    return s
  }
}

export class OneToOneField<M extends ModelClass = ModelClass, const O extends ForeignKeyOptions = ForeignKeyOptions> extends ForeignKey<
  M,
  O
> {
  static override readonly internalType: string = 'OneToOneField'
  override manyToOne = false
  override oneToOne = true
  constructor(to: RelationTarget<M>, options: O) {
    super(to, options)
    this.unique = true
  }
}

// ---- ManyToManyField ----------------------------------------------------------------------------

export interface ManyToManyFieldOptions extends RelatedFieldOptions {
  /** Custom intermediate model (must have FKs to both sides). Default: auto-created `${table}_${field}`. */
  through?: RelationTarget
  /** `[sourceFkName, targetFkName]` on the through model, when ambiguous. */
  throughFields?: readonly [string, string]
  /** Table name of the auto-created through model. */
  dbTable?: string
}

/** Many-to-many relation through an intermediate table (auto-created like Django's). */
export class ManyToManyField<M extends ModelClass = ModelClass, const O extends ManyToManyFieldOptions = ManyToManyFieldOptions> extends RelatedField<
  unknown,
  O
> {
  static override readonly internalType: string = 'ManyToManyField'
  declare readonly __target: M
  override manyToMany = true
  override concrete = false
  /** Resolved through model (auto-created or custom). */
  throughModel?: ModelClass

  constructor(to: RelationTarget<M>, options: O = {} as O) {
    super(to, options)
    if (options.null) {
      // Django warns: null has no effect on ManyToManyField.
      this.null = false
    }
  }

  override getColumnName(): string {
    return ''
  }

  override clone(): this {
    const c = super.clone()
    c.throughModel = undefined
    return c
  }

  get hasCustomThrough(): boolean {
    return this.options.through !== undefined
  }

  /** Table of the auto-created through model: `${model table}_${snake(field)}` (Django-style). */
  m2mDbTable(): string {
    if (this.options.dbTable) return this.options.dbTable
    if (this.throughModel && this.hasCustomThrough) return this.throughModel._meta.dbTable
    return `${this.model._meta.dbTable}_${snakeCase(this.name)}`
  }

  /** Names of the through-model FKs: [pointing at source model, pointing at target model]. */
  throughFieldNames(): [string, string] {
    if (this.options.throughFields) return [this.options.throughFields[0], this.options.throughFields[1]]
    const through = this.through
    const src = this.model
    const tgt = this.relatedModel
    const fks = through._meta.fields.filter((f) => f instanceof ForeignKey) as ForeignKey[]
    if (src === tgt) {
      const auto = fks.filter((f) => f.relatedModel === src)
      const from = auto.find((f) => f.name.startsWith('from')) ?? auto[0]
      const to = auto.find((f) => f !== from) ?? auto[1]
      return [from.name, to.name]
    }
    const from = fks.find((f) => f.relatedModel === src)
    const to = fks.find((f) => f.relatedModel === tgt)
    if (!from || !to) {
      throw new TypeError(`The through model of ${String(this)} must have foreign keys to both related models.`)
    }
    return [from.name, to.name]
  }

  /** The through model (auto-created when the target resolves). */
  get through(): ModelClass {
    if (!this.throughModel) {
      void this.relatedModel // resolution creates the through model
      if (!this.throughModel) throw new TypeError(`Through model of ${String(this)} is not resolved yet.`)
    }
    return this.throughModel
  }

  override dbType(): string | null {
    return null
  }

  override getDefault(): null {
    return null
  }

  override validate(): void {}

  protected override deconstructExtra(): Record<string, unknown> {
    const out = super.deconstructExtra()
    if (this.options.through !== undefined) {
      try {
        out.through = this.through._meta.label
      } catch {
        out.through = typeof this.options.through === 'string' ? this.options.through : '?'
      }
    }
    if (this.options.throughFields) out.throughFields = this.options.throughFields
    if (this.options.dbTable) out.dbTable = this.options.dbTable
    return out
  }

  override formHint(): FormHint {
    let label = '?'
    try {
      label = this.relatedModel._meta.label
    } catch {}
    return {
      ...this.withHintCommon({ widget: 'select-multiple' }),
      widget: 'select-multiple',
      relatedModel: label,
      multiple: true,
      required: !this.blank,
      limitChoicesTo: this.limitChoicesTo,
    }
  }

  protected override baseJsonSchema(): Record<string, unknown> {
    let items: Record<string, unknown> = { type: ['integer', 'string'] }
    try {
      const t = this.relatedModel._meta.pk.jsonSchema()
      items = { type: t.type, ...(t.format ? { format: t.format } : {}) }
    } catch {}
    return { type: 'array', items }
  }

  override jsonSchema(): Record<string, unknown> {
    const s = super.jsonSchema()
    try {
      s['x-related-model'] = this.relatedModel._meta.label
    } catch {}
    return s
  }
}

// ---- reverse side -------------------------------------------------------------------------------

/**
 * The reverse side of a relation (Django's `ForeignObjectRel`), listed in `_meta.relatedObjects` of the
 * target model. `model` is the target (where the reverse accessor lives), `relatedModel` the model
 * that declares the field.
 */
export class RelatedObject {
  readonly isRelation = true
  readonly concrete = false
  readonly autoCreated = true
  readonly editable = false
  readonly manyToOne = false
  readonly oneToMany: boolean
  readonly oneToOne: boolean
  readonly manyToMany: boolean
  readonly multiple: boolean
  readonly internalType = 'RelatedObject'

  constructor(
    readonly field: RelatedField<any, any>,
    readonly model: ModelClass,
  ) {
    this.oneToMany = field.manyToOne
    this.oneToOne = field.oneToOne
    this.manyToMany = field.manyToMany
    this.multiple = !field.oneToOne
  }

  get relatedModel(): ModelClass {
    return this.field.model
  }

  get hidden(): boolean {
    return this.field.reverseHidden || this.relatedModel._meta.autoCreated
  }

  /** Name used in lookups (`User.objects.filter({ posts__title: … })`). */
  get name(): string {
    return this.field.relatedQueryName ?? (this.field.relatedName && !this.field.reverseHidden ? this.field.relatedName : lowerFirst(this.relatedModel._meta.objectName))
  }

  get relatedQueryName(): string {
    return this.name
  }

  /** Attribute on target instances (`user.posts`, default `user.postSet` / `user.profile`). */
  getAccessorName(): string | null {
    if (this.field.reverseHidden) return null
    if (this.field.relatedName) return this.field.relatedName
    const base = lowerFirst(this.relatedModel._meta.objectName)
    return this.oneToOne ? base : `${base}Set`
  }

  get accessorName(): string | null {
    return this.getAccessorName()
  }

  get onDelete(): OnDelete | undefined {
    return (this.field as ForeignKey).onDelete
  }

  get verboseName(): string {
    return this.relatedModel._meta.verboseName
  }

  toString(): string {
    return `<RelatedObject: ${this.relatedModel._meta.label}.${this.field.name}>`
  }
}

/** Throw if a FK value refers to a missing row (used by fullClean). */
export function invalidRelatedError(field: ForeignKey, value: unknown): ValidationError {
  let name = 'object'
  try {
    name = field.relatedModel._meta.verboseName
  } catch {}
  return new ValidationError(`${name} instance with ${field.targetField.name} ${JSON.stringify(value)} does not exist.`, {
    code: 'invalid',
  })
}
