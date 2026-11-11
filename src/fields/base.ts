import { ValidationError } from '@ghuri/core'
import type { BaseModel, ModelClass } from '../models/types'
import { type Dialect, Sql } from '../query/sql'
import { capfirst, humanize, snakeCase } from '../utils'
import { runValidator, type Validator } from '../validators'

export type { Dialect }

/** `[value, label][]`, or an enum-like object `{ Draft: 'draft' }` (labels derived from keys). */
export type Choices = ReadonlyArray<readonly [unknown, string]> | Record<string, string | number>

export interface FieldOptions<T = any> {
  null?: boolean
  blank?: boolean
  /** A value or a function returning one (use a function for mutable values). */
  default?: T | null | (() => T | null)
  choices?: Choices
  primaryKey?: boolean
  unique?: boolean
  dbIndex?: boolean
  dbColumn?: string
  dbComment?: string
  editable?: boolean
  helpText?: string
  verboseName?: string
  validators?: readonly Validator[]
  errorMessages?: Record<string, string>
  /** Database-level default, emitted in DDL. */
  dbDefault?: unknown
  /** Include in serialization (dumpdata). Default true. */
  serialize?: boolean
}

export interface FieldDeconstruction {
  type: string
  options: Record<string, unknown>
}

export type FormWidget =
  | 'text'
  | 'textarea'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'date'
  | 'datetime'
  | 'time'
  | 'email'
  | 'url'
  | 'json'
  | 'file'
  | 'select-multiple'
  | 'hidden'
  | 'password'

export interface FormHint {
  widget: FormWidget
  [k: string]: unknown
}

export const EMPTY_VALUES: readonly unknown[] = [null, undefined, '']

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.keys(v).length === 0
  return false
}

const DEFAULT_ERRORS: Record<string, string> = {
  invalid_choice: 'Value %(value)s is not a valid choice.',
  null: 'This field cannot be null.',
  blank: 'This field cannot be blank.',
  unique: '%(modelName)s with this %(fieldLabel)s already exists.',
}

function normalizeChoices(choices: Choices | undefined): Array<[unknown, string]> | undefined {
  if (!choices) return undefined
  if (Array.isArray(choices)) return choices.map(([v, l]) => [v, String(l)])
  return Object.entries(choices)
    .filter(([k]) => !/^\d+$/.test(k)) // numeric TS enums have reverse mappings
    .map(([k, v]) => [v, capfirst(humanize(k))])
}

let creationCounter = 0

/**
 * Base class of every model field. Instances are created in `Model({...})` field maps and bound to a
 * concrete model class (cloned per model) when the model is prepared.
 *
 * `T` is the JS value type; `O` the options literal (used to infer `null: true` → `T | null`).
 */
export abstract class Field<T = unknown, O extends FieldOptions = FieldOptions> {
  /** Phantom members used by the model typing helpers. */
  declare readonly __value: T
  declare readonly __options: O

  static readonly internalType: string = 'Field'

  name = ''
  attname = ''
  /** Database column name (snake_case of the attribute unless `dbColumn`). */
  column = ''
  model!: ModelClass

  null: boolean
  blank: boolean
  primaryKey: boolean
  unique: boolean
  dbIndex: boolean
  dbColumn?: string
  dbComment?: string
  editable: boolean
  helpText?: string
  choices?: Array<[unknown, string]>
  maxLength?: number
  validators: Validator[]
  errorMessages: Record<string, string>
  dbDefault?: unknown
  serialize: boolean
  readonly options: O
  readonly creationCounter: number

  isRelation = false
  manyToOne = false
  oneToOne = false
  manyToMany = false
  oneToMany = false
  /** Has a column in the model's table (false for ManyToManyField). */
  concrete = true
  autoCreated = false
  hidden = false
  /** Values that count as empty for `blank` validation. */
  emptyStringsAllowed = true

  private _verboseName?: string

  constructor(options: O = {} as O) {
    this.options = options
    this.null = options.null ?? false
    this.blank = options.blank ?? false
    this.primaryKey = options.primaryKey ?? false
    this.unique = (options.unique ?? false) || this.primaryKey
    this.dbIndex = options.dbIndex ?? false
    this.dbColumn = options.dbColumn
    this.dbComment = options.dbComment
    this.editable = options.editable ?? true
    this.helpText = options.helpText
    this.choices = normalizeChoices(options.choices)
    this.validators = [...(options.validators ?? [])]
    this.errorMessages = { ...DEFAULT_ERRORS, ...(options.errorMessages ?? {}) }
    this.dbDefault = options.dbDefault
    this.serialize = options.serialize ?? !this.primaryKey
    this._verboseName = options.verboseName
    this.creationCounter = creationCounter++
  }

  get internalType(): string {
    return (this.constructor as typeof Field).internalType
  }

  get verboseName(): string {
    return this._verboseName ?? humanize(this.name)
  }
  set verboseName(v: string) {
    this._verboseName = v
  }

  /** The related model for relation fields (resolved lazily). */
  get relatedModel(): ModelClass | undefined {
    return undefined
  }

  get isAutoField(): boolean {
    return false
  }

  /** Attribute holding the raw value on instances (`authorId` for FK `author`). */
  getAttname(): string {
    return this.name
  }

  getColumnName(): string {
    return this.dbColumn ?? snakeCase(this.attname)
  }

  /** Bind the field to a model under `name`. Called once per concrete model on a cloned field. */
  contributeToClass(model: ModelClass, name: string): void {
    this.name = name
    this.model = model
    this.attname = this.getAttname()
    this.column = this.getColumnName()
  }

  /** Shallow copy, unbound (fields are cloned for every concrete model that inherits them). */
  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    copy.validators = [...this.validators]
    return copy
  }

  hasDefault(): boolean {
    return this.options.default !== undefined
  }

  getDefault(): T | null {
    if (this.hasDefault()) {
      const d = this.options.default
      return (typeof d === 'function' ? (d as () => T)() : d) as T | null
    }
    if (!this.emptyStringsAllowed || this.null) return null
    return '' as T
  }

  // ---- value conversion -------------------------------------------------------------------------

  /** Coerce input (forms, JSON, constructor) to the JS value type. Throws ValidationError. */
  toPython(value: unknown): T {
    return value as T
  }

  /** Prepare a JS value for a query parameter. */
  toDb(value: T | null | undefined, _dialect: Dialect): unknown {
    return value === undefined ? null : value
  }

  /** Convert a value read from the database to the JS value type. */
  fromDb(value: unknown, _dialect: Dialect): T | null {
    return value as T | null
  }

  /** Value used in lookups (`filter({ field: value })`), before `toDb`. */
  getPrepValue(value: unknown): unknown {
    return value
  }

  /** Placeholder SQL for a value of this field (JSONField casts on PostgreSQL). */
  dbParam(value: unknown, dialect: Dialect): Sql {
    return Sql.param(this.toDb(value as T, dialect))
  }

  /** Value to save; `autoNow` fields update the instance here. */
  preSave(instance: BaseModel, _add: boolean): unknown {
    return (instance as any)[this.attname]
  }

  valueFromObject(instance: BaseModel): unknown {
    return (instance as any)[this.attname]
  }

  // ---- validation -------------------------------------------------------------------------------

  /** Built-in validators for this field type (e.g. MaxLengthValidator for CharField). */
  get defaultValidators(): Validator[] {
    return []
  }

  getChoices(): Array<[unknown, string]> {
    return this.choices ?? []
  }

  protected error(code: string, params: Record<string, unknown> = {}): ValidationError {
    const tpl = this.errorMessages[code] ?? code
    const msg = tpl.replace(/%\((\w+)\)s/g, (_, k) => String(params[k]))
    return new ValidationError(msg, { code })
  }

  /** Validate a (python) value: choices, null, blank, then built-in and custom validators. */
  validate(value: T | null | undefined, _instance?: BaseModel): void {
    if (!this.editable && !this.primaryKey) return
    if (this.choices && !isEmptyValue(value)) {
      const ok = this.choices.some(([v]) => v === value || String(v) === String(value))
      if (!ok) throw this.error('invalid_choice', { value: JSON.stringify(value) })
    }
    if (value === null || value === undefined) {
      if (!this.null) throw this.error('null')
      return
    }
    if (!this.blank && isEmptyValue(value)) throw this.error('blank')
    if (isEmptyValue(value)) return
    const messages: string[] = []
    for (const v of [...this.defaultValidators, ...this.validators]) {
      try {
        runValidator(v, value)
      } catch (e) {
        if (e instanceof ValidationError) messages.push(...e.messages)
        else throw e
      }
    }
    if (messages.length) throw new ValidationError(messages)
  }

  /** `toPython` + `validate`; returns the cleaned value. */
  clean(value: unknown, instance?: BaseModel): T | null {
    const v = value === null || value === undefined ? null : this.toPython(value)
    this.validate(v, instance)
    return v
  }

  // ---- schema -----------------------------------------------------------------------------------

  /** Column type for `dialect`, or null when the field has no column. */
  dbType(dialect: Dialect): string | null {
    return dbTypeFor(this, dialect)
  }

  /** CHECK constraint SQL (without the CHECK keyword) or null. */
  dbCheck(_dialect: Dialect): string | null {
    return null
  }

  /** Build a drizzle column for this field (escape hatch). Implemented in drizzle.ts. */
  drizzleColumn(dialect: Dialect): any {
    return buildDrizzleColumnHook(this, dialect)
  }

  /** JSON-able `{ type, options }` used by migrations. */
  deconstruct(): FieldDeconstruction {
    const o = this.options as FieldOptions
    const options: Record<string, unknown> = {}
    const keys: Array<keyof FieldOptions> = [
      'null',
      'blank',
      'primaryKey',
      'unique',
      'dbIndex',
      'dbColumn',
      'dbComment',
      'editable',
      'helpText',
      'verboseName',
      'dbDefault',
    ]
    for (const k of keys) if (o[k] !== undefined) options[k] = o[k]
    if (o.default !== undefined) {
      if (typeof o.default === 'function')
        options.default = { callable: (o.default as Function).name || 'anonymous' }
      else options.default = o.default instanceof Date ? o.default.toISOString() : o.default
    }
    if (this.choices) options.choices = this.choices.map(([v, l]) => [v, l])
    const validators = (o.validators ?? [])
      .map((v) => (typeof v === 'object' && v && 'deconstruct' in v ? v.deconstruct?.() : undefined))
      .filter(Boolean)
    if (validators.length) options.validators = validators
    Object.assign(options, this.deconstructExtra())
    return { type: this.internalType, options }
  }

  /** Field-specific options for `deconstruct()`. */
  protected deconstructExtra(): Record<string, unknown> {
    return {}
  }

  // ---- introspection for rest / admin / agents ---------------------------------------------------

  formHint(): FormHint {
    const base: FormHint = { widget: 'text' }
    if (this.choices) {
      base.widget = 'select'
      base.choices = this.getChoices()
    }
    return this.withHintCommon(base)
  }

  protected withHintCommon(hint: FormHint): FormHint {
    return {
      ...hint,
      label: capfirst(this.verboseName),
      required: !this.blank,
      helpText: this.helpText,
      disabled: !this.editable,
      ...(this.choices && hint.widget !== 'select-multiple'
        ? { widget: 'select', choices: this.getChoices() }
        : {}),
    }
  }

  /** Base JSON schema of the value type (without null/metadata). */
  protected baseJsonSchema(): Record<string, unknown> {
    return {}
  }

  jsonSchema(): Record<string, unknown> {
    const schema: Record<string, unknown> = { ...this.baseJsonSchema() }
    if (this.choices) schema.enum = this.choices.map(([v]) => v)
    if (this.null && typeof schema.type === 'string') {
      schema.type = [schema.type, 'null']
      if (schema.enum) (schema.enum as unknown[]).push(null)
    }
    schema.title = capfirst(this.verboseName)
    if (this.helpText) schema.description = this.helpText
    if (this.hasDefault() && typeof this.options.default !== 'function') {
      const d = this.options.default
      schema.default = d instanceof Date ? d.toISOString() : d
    }
    if (!this.editable) schema.readOnly = true
    return schema
  }

  toString(): string {
    return this.model ? `${(this.model as any).name}.${this.name}` : `<${this.internalType}>`
  }
}

// ---- DB type mapping (extended by the migrations schema editors) -----------------------------------

type TypeSpec = string | ((f: Field<any, any>) => string)

/**
 * Column types per dialect keyed by `internalType`. Custom fields can either override `dbType()` or
 * register a type here with `registerDbType()`.
 */
export const DB_TYPES: Record<Dialect, Record<string, TypeSpec>> = {
  sqlite: {
    AutoField: 'integer',
    BigAutoField: 'integer',
    SmallAutoField: 'integer',
    CharField: (f) => `varchar(${f.maxLength ?? 255})`,
    TextField: 'text',
    SlugField: (f) => `varchar(${f.maxLength ?? 50})`,
    EmailField: (f) => `varchar(${f.maxLength ?? 254})`,
    URLField: (f) => `varchar(${f.maxLength ?? 200})`,
    UUIDField: 'char(36)',
    GenericIPAddressField: 'varchar(39)',
    IntegerField: 'integer',
    BigIntegerField: 'bigint',
    SmallIntegerField: 'smallint',
    PositiveIntegerField: 'integer',
    PositiveBigIntegerField: 'bigint',
    PositiveSmallIntegerField: 'smallint',
    FloatField: 'real',
    DecimalField: (f: any) => `decimal(${f.maxDigits ?? 20}, ${f.decimalPlaces ?? 2})`,
    BooleanField: 'integer',
    DateField: 'text',
    DateTimeField: 'text',
    TimeField: 'text',
    DurationField: 'bigint',
    JSONField: 'text',
    BinaryField: 'blob',
  },
  postgresql: {
    AutoField: 'integer',
    BigAutoField: 'bigint',
    SmallAutoField: 'smallint',
    CharField: (f) => `varchar(${f.maxLength ?? 255})`,
    TextField: 'text',
    SlugField: (f) => `varchar(${f.maxLength ?? 50})`,
    EmailField: (f) => `varchar(${f.maxLength ?? 254})`,
    URLField: (f) => `varchar(${f.maxLength ?? 200})`,
    UUIDField: 'uuid',
    GenericIPAddressField: 'varchar(39)',
    IntegerField: 'integer',
    BigIntegerField: 'bigint',
    SmallIntegerField: 'smallint',
    PositiveIntegerField: 'integer',
    PositiveBigIntegerField: 'bigint',
    PositiveSmallIntegerField: 'smallint',
    FloatField: 'double precision',
    DecimalField: (f: any) => `numeric(${f.maxDigits ?? 20}, ${f.decimalPlaces ?? 2})`,
    BooleanField: 'boolean',
    DateField: 'date',
    DateTimeField: 'timestamp with time zone',
    TimeField: 'time',
    DurationField: 'bigint',
    JSONField: 'jsonb',
    BinaryField: 'bytea',
  },
}

export function registerDbType(internalType: string, types: Partial<Record<Dialect, TypeSpec>>): void {
  for (const [d, spec] of Object.entries(types) as Array<[Dialect, TypeSpec]>)
    DB_TYPES[d][internalType] = spec
}

export function dbTypeFor(field: Field<any, any>, dialect: Dialect): string | null {
  const spec = DB_TYPES[dialect][field.internalType]
  if (spec === undefined) return null
  return typeof spec === 'function' ? spec(field) : spec
}

// drizzle.ts installs the real builder (keeps this module free of drizzle imports).
let buildDrizzleColumnHook: (field: Field<any, any>, dialect: Dialect) => any = () => {
  throw new Error('drizzle column builder not installed')
}
export function setDrizzleColumnBuilder(fn: (field: Field<any, any>, dialect: Dialect) => any): void {
  buildDrizzleColumnHook = fn
}
