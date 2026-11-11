import { ValidationError } from '@ghuri/core'
import type { BaseModel } from '../models/types'
import { type Dialect, Sql } from '../query/sql'
import {
  DecimalValidator,
  EmailValidator,
  MaxLengthValidator,
  MaxValueValidator,
  MinValueValidator,
  ProhibitNullCharactersValidator,
  URLValidator,
  type Validator,
  validateIPv4Address,
  validateIPv6Address,
  validateIPv46Address,
  validateSlug,
  validateUnicodeSlug,
} from '../validators'
import { Field, type FieldOptions, type FormHint } from './base'

// ---- automatic primary keys ---------------------------------------------------------------------

export class AutoField<const O extends FieldOptions<number> = {}> extends Field<number, O> {
  static override readonly internalType: string = 'AutoField'
  constructor(options: O = {} as O) {
    super({ primaryKey: true, ...options } as O)
    this.blank = true
    this.editable = false
    this.serialize = false
  }
  override get isAutoField(): boolean {
    return true
  }
  override getDefault(): null {
    return null
  }
  override toPython(value: unknown): number {
    return toInteger(value, this)
  }
  override fromDb(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value)
  }
  override validate(): void {}
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'hidden' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'integer' }
  }
}
export class BigAutoField<const O extends FieldOptions<number> = {}> extends AutoField<O> {
  static override readonly internalType: string = 'BigAutoField'
}
export class SmallAutoField<const O extends FieldOptions<number> = {}> extends AutoField<O> {
  static override readonly internalType: string = 'SmallAutoField'
}

// ---- strings ------------------------------------------------------------------------------------

export interface CharFieldOptions extends FieldOptions<string> {
  maxLength?: number
}

export class CharField<const O extends CharFieldOptions = {}> extends Field<string, O> {
  static override readonly internalType: string = 'CharField'
  constructor(options: O = {} as O) {
    super(options)
    this.maxLength = options.maxLength ?? this.defaultMaxLength()
  }
  protected defaultMaxLength(): number | undefined {
    return 255
  }
  override get defaultValidators(): Validator[] {
    const v: Validator[] = [new ProhibitNullCharactersValidator()]
    if (this.maxLength !== undefined) v.push(new MaxLengthValidator(this.maxLength))
    return v
  }
  override toPython(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return value as unknown as string
    return String(value)
  }
  override toDb(value: string | null | undefined): unknown {
    return value === undefined || value === null ? null : String(value)
  }
  override getPrepValue(value: unknown): unknown {
    return value === null || value === undefined ? value : typeof value === 'object' ? value : String(value)
  }
  protected override deconstructExtra(): Record<string, unknown> {
    return this.options.maxLength !== undefined ? { maxLength: this.options.maxLength } : {}
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'text', maxLength: this.maxLength })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return this.maxLength !== undefined ? { type: 'string', maxLength: this.maxLength } : { type: 'string' }
  }
}

export class TextField<const O extends CharFieldOptions = {}> extends CharField<O> {
  static override readonly internalType: string = 'TextField'
  protected override defaultMaxLength(): number | undefined {
    return undefined
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'textarea', maxLength: this.maxLength })
  }
}

export interface SlugFieldOptions extends CharFieldOptions {
  allowUnicode?: boolean
}
export class SlugField<const O extends SlugFieldOptions = {}> extends CharField<O> {
  static override readonly internalType: string = 'SlugField'
  constructor(options: O = {} as O) {
    super({ dbIndex: true, ...options } as O)
  }
  protected override defaultMaxLength(): number {
    return 50
  }
  override get defaultValidators(): Validator[] {
    return [...super.defaultValidators, this.options.allowUnicode ? validateUnicodeSlug : validateSlug]
  }
  protected override deconstructExtra(): Record<string, unknown> {
    const extra = super.deconstructExtra()
    if (this.options.allowUnicode) extra.allowUnicode = true
    return extra
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { ...super.baseJsonSchema(), pattern: this.options.allowUnicode ? '^[-\\w]+$' : '^[-a-zA-Z0-9_]+$' }
  }
}

export class EmailField<const O extends CharFieldOptions = {}> extends CharField<O> {
  static override readonly internalType: string = 'EmailField'
  protected override defaultMaxLength(): number {
    return 254
  }
  override get defaultValidators(): Validator[] {
    return [...super.defaultValidators, new EmailValidator()]
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'email', maxLength: this.maxLength })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { ...super.baseJsonSchema(), format: 'email' }
  }
}

export class URLField<const O extends CharFieldOptions = {}> extends CharField<O> {
  static override readonly internalType: string = 'URLField'
  protected override defaultMaxLength(): number {
    return 200
  }
  override get defaultValidators(): Validator[] {
    return [...super.defaultValidators, new URLValidator()]
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'url', maxLength: this.maxLength })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { ...super.baseJsonSchema(), format: 'uri' }
  }
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export class UUIDField<const O extends FieldOptions<string> = {}> extends Field<string, O> {
  static override readonly internalType: string = 'UUIDField'
  override emptyStringsAllowed = false
  override toPython(value: unknown): string {
    const s = String(value).trim()
    if (!UUID_RE.test(s)) throw new ValidationError(`“${s}” is not a valid UUID.`, { code: 'invalid' })
    const hex = s.replace(/-/g, '').toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  override toDb(value: string | null | undefined): unknown {
    if (value === null || value === undefined) return null
    return UUID_RE.test(String(value)) ? this.toPython(value) : value
  }
  override fromDb(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value)
  }
  override getPrepValue(value: unknown): unknown {
    return typeof value === 'string' && UUID_RE.test(value) ? this.toPython(value) : value
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', format: 'uuid' }
  }
}

export interface GenericIPAddressFieldOptions extends FieldOptions<string> {
  protocol?: 'both' | 'IPv4' | 'IPv6'
  unpackIpv4?: boolean
}
export class GenericIPAddressField<const O extends GenericIPAddressFieldOptions = {}> extends Field<string, O> {
  static override readonly internalType: string = 'GenericIPAddressField'
  override emptyStringsAllowed = false
  constructor(options: O = {} as O) {
    super(options)
    this.maxLength = 39
  }
  override get defaultValidators(): Validator[] {
    const p = this.options.protocol ?? 'both'
    return [p === 'IPv4' ? validateIPv4Address : p === 'IPv6' ? validateIPv6Address : validateIPv46Address]
  }
  override toPython(value: unknown): string {
    return String(value).trim().toLowerCase()
  }
  override toDb(value: string | null | undefined): unknown {
    return value === undefined || value === null || value === '' ? null : String(value)
  }
  protected override deconstructExtra(): Record<string, unknown> {
    return this.options.protocol ? { protocol: this.options.protocol } : {}
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    const p = this.options.protocol ?? 'both'
    return p === 'IPv4' ? { type: 'string', format: 'ipv4' } : p === 'IPv6' ? { type: 'string', format: 'ipv6' } : { type: 'string' }
  }
}

// ---- numbers ------------------------------------------------------------------------------------

function toInteger(value: unknown, _field?: Field<any, any>): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  const s = String(value).trim()
  if (/^[-+]?\d+$/.test(s)) return Number.parseInt(s, 10)
  if (/^[-+]?\d+\.0*$/.test(s)) return Number.parseInt(s, 10)
  throw new ValidationError(`“${String(value)}” value must be an integer.`, {
    code: 'invalid',
  })
}

export class IntegerField<const O extends FieldOptions<number> = {}> extends Field<number, O> {
  static override readonly internalType: string = 'IntegerField'
  override emptyStringsAllowed = false
  protected range(): [number, number] | null {
    return [-2147483648, 2147483647]
  }
  override get defaultValidators(): Validator[] {
    const r = this.range()
    return r ? [new MinValueValidator(r[0]), new MaxValueValidator(r[1])] : []
  }
  override toPython(value: unknown): number {
    return toInteger(value, this)
  }
  override toDb(value: number | null | undefined): unknown {
    if (value === null || value === undefined) return null
    return typeof value === 'number' ? value : Number(value)
  }
  override fromDb(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value)
  }
  override getPrepValue(value: unknown): unknown {
    if (value === null || value === undefined || typeof value === 'object') return value
    if (typeof value === 'number') return value
    try {
      return toInteger(value, this)
    } catch {
      return value
    }
  }
  override formHint(): FormHint {
    const r = this.range()
    return this.withHintCommon({ widget: 'number', step: 1, ...(r ? { min: r[0], max: r[1] } : {}) })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    const r = this.range()
    return r ? { type: 'integer', minimum: r[0], maximum: r[1] } : { type: 'integer' }
  }
}

export class BigIntegerField<const O extends FieldOptions<number> = {}> extends IntegerField<O> {
  static override readonly internalType: string = 'BigIntegerField'
  protected override range(): [number, number] | null {
    return [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  }
}
export class SmallIntegerField<const O extends FieldOptions<number> = {}> extends IntegerField<O> {
  static override readonly internalType: string = 'SmallIntegerField'
  protected override range(): [number, number] | null {
    return [-32768, 32767]
  }
}
export class PositiveIntegerField<const O extends FieldOptions<number> = {}> extends IntegerField<O> {
  static override readonly internalType: string = 'PositiveIntegerField'
  protected override range(): [number, number] | null {
    return [0, 2147483647]
  }
  override dbCheck(): string | null {
    return `"${this.column}" >= 0`
  }
}
export class PositiveBigIntegerField<const O extends FieldOptions<number> = {}> extends IntegerField<O> {
  static override readonly internalType: string = 'PositiveBigIntegerField'
  protected override range(): [number, number] | null {
    return [0, Number.MAX_SAFE_INTEGER]
  }
  override dbCheck(): string | null {
    return `"${this.column}" >= 0`
  }
}
export class PositiveSmallIntegerField<const O extends FieldOptions<number> = {}> extends IntegerField<O> {
  static override readonly internalType: string = 'PositiveSmallIntegerField'
  protected override range(): [number, number] | null {
    return [0, 32767]
  }
  override dbCheck(): string | null {
    return `"${this.column}" >= 0`
  }
}

export class FloatField<const O extends FieldOptions<number> = {}> extends Field<number, O> {
  static override readonly internalType: string = 'FloatField'
  override emptyStringsAllowed = false
  override toPython(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    if (String(value).trim() === '' || Number.isNaN(n)) {
      throw new ValidationError(`“${String(value)}” value must be a float.`, { code: 'invalid' })
    }
    return n
  }
  override toDb(value: number | null | undefined): unknown {
    return value === null || value === undefined ? null : Number(value)
  }
  override fromDb(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value)
  }
  override getPrepValue(value: unknown): unknown {
    return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'number', step: 'any' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'number' }
  }
}

export interface DecimalFieldOptions extends FieldOptions<string | number> {
  maxDigits?: number
  decimalPlaces?: number
}

/**
 * Exact decimal, represented as a string in JS (`'12.50'`). PostgreSQL stores `numeric(p, s)`; SQLite/D1
 * use NUMERIC affinity (`decimal(p, s)`), so values beyond 15 significant digits lose precision there.
 */
export class DecimalField<const O extends DecimalFieldOptions = {}> extends Field<string, O> {
  static override readonly internalType: string = 'DecimalField'
  override emptyStringsAllowed = false
  readonly maxDigits?: number
  readonly decimalPlaces?: number
  constructor(options: O = {} as O) {
    super(options)
    this.maxDigits = options.maxDigits
    this.decimalPlaces = options.decimalPlaces
  }
  override get defaultValidators(): Validator[] {
    return [new DecimalValidator(this.maxDigits, this.decimalPlaces)]
  }
  private format(n: number | string): string {
    if (typeof n === 'number') {
      return this.decimalPlaces !== undefined ? n.toFixed(this.decimalPlaces) : String(n)
    }
    const s = n.trim()
    if (this.decimalPlaces === undefined || !/^[-+]?\d*(\.\d*)?$/.test(s)) return s
    const neg = s.startsWith('-')
    const [i, f = ''] = s.replace(/^[-+]/, '').split('.')
    if (f.length > this.decimalPlaces) return Number(s).toFixed(this.decimalPlaces)
    const frac = f.padEnd(this.decimalPlaces, '0')
    const out = `${i || '0'}${this.decimalPlaces > 0 ? `.${frac}` : ''}`
    return neg ? `-${out}` : out
  }
  override toPython(value: unknown): string {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ValidationError(`“${value}” value must be a decimal number.`, { code: 'invalid' })
      return this.format(value)
    }
    const s = String(value).trim()
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      throw new ValidationError(`“${s}” value must be a decimal number.`, { code: 'invalid' })
    }
    return s
  }
  override toDb(value: string | null | undefined): unknown {
    if (value === null || value === undefined) return null
    return this.format(value as string | number)
  }
  override fromDb(value: unknown): string | null {
    if (value === null || value === undefined) return null
    return this.format(typeof value === 'number' ? value : String(value))
  }
  override getPrepValue(value: unknown): unknown {
    return typeof value === 'number' || typeof value === 'string' ? this.format(value) : value
  }
  protected override deconstructExtra(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (this.maxDigits !== undefined) out.maxDigits = this.maxDigits
    if (this.decimalPlaces !== undefined) out.decimalPlaces = this.decimalPlaces
    return out
  }
  override formHint(): FormHint {
    const step = this.decimalPlaces !== undefined ? (10 ** -this.decimalPlaces).toFixed(this.decimalPlaces) : 'any'
    return this.withHintCommon({ widget: 'number', step, maxDigits: this.maxDigits, decimalPlaces: this.decimalPlaces })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', format: 'decimal', pattern: '^-?\\d+(\\.\\d+)?$' }
  }
}

// ---- booleans -----------------------------------------------------------------------------------

const TRUE_STRINGS = new Set(['true', 't', '1', 'yes', 'y', 'on'])
const FALSE_STRINGS = new Set(['false', 'f', '0', 'no', 'n', 'off'])

export class BooleanField<const O extends FieldOptions<boolean> = {}> extends Field<boolean, O> {
  static override readonly internalType: string = 'BooleanField'
  override emptyStringsAllowed = false
  constructor(options: O = {} as O) {
    super(options)
    if (options.default !== undefined && options.blank === undefined) this.blank = true
  }
  override toPython(value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (value === 1 || value === 0) return value === 1
    const s = String(value).trim().toLowerCase()
    if (TRUE_STRINGS.has(s)) return true
    if (FALSE_STRINGS.has(s)) return false
    throw new ValidationError(`“${String(value)}” value must be either true or false.`, { code: 'invalid' })
  }
  override toDb(value: boolean | null | undefined, dialect: Dialect): unknown {
    if (value === null || value === undefined) return null
    const b = this.toPython(value)
    return dialect === 'sqlite' ? (b ? 1 : 0) : b
  }
  override fromDb(value: unknown): boolean | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' || typeof value === 'bigint') return Number(value) !== 0
    return this.toPython(value)
  }
  override getPrepValue(value: unknown): unknown {
    if (value === null || value === undefined || typeof value === 'object') return value
    try {
      return this.toPython(value)
    } catch {
      return value
    }
  }
  override validate(value: boolean | null | undefined, instance?: BaseModel): void {
    if (value === false) return // `false` is never "blank"
    super.validate(value, instance)
  }
  override formHint(): FormHint {
    return { ...this.withHintCommon({ widget: 'checkbox' }), required: false }
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'boolean' }
  }
}

/** Deprecated Django alias. */
export class NullBooleanField<const O extends FieldOptions<boolean> = {}> extends BooleanField<O & { null: true }> {
  constructor(options: O = {} as O) {
    super({ ...options, null: true, blank: true } as O & { null: true })
  }
}

// ---- dates & times ------------------------------------------------------------------------------

export interface DateFieldOptions<T = unknown> extends FieldOptions<T> {
  autoNow?: boolean
  autoNowAdd?: boolean
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

export function toDateString(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Dates are `'YYYY-MM-DD'` strings in JS; `date` in PostgreSQL, text in SQLite/D1. */
export class DateField<const O extends DateFieldOptions<string | Date> = {}> extends Field<string, O> {
  static override readonly internalType: string = 'DateField'
  override emptyStringsAllowed = false
  readonly autoNow: boolean
  readonly autoNowAdd: boolean
  constructor(options: O = {} as O) {
    super(options)
    this.autoNow = options.autoNow ?? false
    this.autoNowAdd = options.autoNowAdd ?? false
    if (this.autoNow || this.autoNowAdd) {
      this.editable = false
      this.blank = true
    }
  }
  protected now(): unknown {
    return toDateString(new Date())
  }
  override preSave(instance: BaseModel, add: boolean): unknown {
    if (this.autoNow || (this.autoNowAdd && add)) {
      const v = this.now()
      ;(instance as any)[this.attname] = v
      return v
    }
    return super.preSave(instance, add)
  }
  override toPython(value: unknown): string {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw this.invalid(value)
      return toDateString(value)
    }
    const s = String(value).trim()
    const m = DATE_RE.exec(s)
    if (m) {
      const d = new Date(`${s}T00:00:00Z`)
      if (Number.isNaN(d.getTime()) || toDateString(d) !== s) throw this.invalid(value)
      return s
    }
    // datetime string → date part
    const d = new Date(s)
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s) && !Number.isNaN(d.getTime())) return s.slice(0, 10)
    throw this.invalid(value)
  }
  protected invalid(value: unknown): ValidationError {
    return new ValidationError(`“${String(value)}” value has an invalid date format. It must be in YYYY-MM-DD format.`, {
      code: 'invalid',
    })
  }
  override toDb(value: string | null | undefined): unknown {
    if (value === null || value === undefined) return null
    return this.toPython(value)
  }
  override fromDb(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return toDateString(value)
    return String(value).slice(0, 10)
  }
  override getPrepValue(value: unknown): unknown {
    if (value instanceof Date || typeof value === 'string') {
      try {
        return this.toPython(value)
      } catch {
        return value
      }
    }
    return value
  }
  protected override deconstructExtra(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (this.autoNow) out.autoNow = true
    if (this.autoNowAdd) out.autoNowAdd = true
    return out
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'date' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', format: 'date' }
  }
}

/** Instants as `Date`. ISO-8601 UTC text (`2024-01-02T03:04:05.000Z`) in SQLite/D1, `timestamptz` in PostgreSQL. */
export class DateTimeField<const O extends DateFieldOptions<Date | string | number> = {}> extends Field<Date, O> {
  static override readonly internalType: string = 'DateTimeField'
  override emptyStringsAllowed = false
  readonly autoNow: boolean
  readonly autoNowAdd: boolean
  constructor(options: O = {} as O) {
    super(options)
    this.autoNow = options.autoNow ?? false
    this.autoNowAdd = options.autoNowAdd ?? false
    if (this.autoNow || this.autoNowAdd) {
      this.editable = false
      this.blank = true
    }
  }
  override preSave(instance: BaseModel, add: boolean): unknown {
    if (this.autoNow || (this.autoNowAdd && add)) {
      const v = new Date()
      ;(instance as any)[this.attname] = v
      return v
    }
    return super.preSave(instance, add)
  }
  override getDefault(): Date | null {
    const d = super.getDefault() as unknown
    if (d === '' || d === undefined) return null
    return d === null ? null : this.toPython(d)
  }
  override toPython(value: unknown): Date {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw this.invalid(value)
      return value
    }
    if (typeof value === 'number') return new Date(value)
    const s = String(value).trim()
    // Accept 'YYYY-MM-DD HH:MM[:SS]' and date-only strings as UTC.
    let normalized = s
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) normalized = `${s}T00:00:00Z`
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) normalized = `${s.replace(' ', 'T')}Z`
    const d = new Date(normalized)
    if (Number.isNaN(d.getTime())) throw this.invalid(value)
    return d
  }
  protected invalid(value: unknown): ValidationError {
    return new ValidationError(
      `“${String(value)}” value has an invalid format. It must be in YYYY-MM-DD HH:MM[:ss[.uuuuuu]][TZ] format.`,
      { code: 'invalid' },
    )
  }
  override toDb(value: Date | null | undefined): unknown {
    if (value === null || value === undefined) return null
    return this.toPython(value).toISOString()
  }
  override fromDb(value: unknown): Date | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value
    if (typeof value === 'number') return new Date(value)
    const s = String(value)
    // Postgres text output without 'T'; SQLite values written by other tools may lack a zone.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return new Date(`${s.replace(' ', 'T')}Z`)
    return new Date(s)
  }
  override getPrepValue(value: unknown): unknown {
    if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
      try {
        return this.toPython(value)
      } catch {
        return value
      }
    }
    return value
  }
  protected override deconstructExtra(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (this.autoNow) out.autoNow = true
    if (this.autoNowAdd) out.autoNowAdd = true
    return out
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'datetime' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', format: 'date-time' }
  }
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/

/** Times of day as `'HH:MM:SS[.ffffff]'` strings. */
export class TimeField<const O extends DateFieldOptions<string> = {}> extends Field<string, O> {
  static override readonly internalType: string = 'TimeField'
  override emptyStringsAllowed = false
  readonly autoNow: boolean
  readonly autoNowAdd: boolean
  constructor(options: O = {} as O) {
    super(options)
    this.autoNow = options.autoNow ?? false
    this.autoNowAdd = options.autoNowAdd ?? false
    if (this.autoNow || this.autoNowAdd) {
      this.editable = false
      this.blank = true
    }
  }
  override preSave(instance: BaseModel, add: boolean): unknown {
    if (this.autoNow || (this.autoNowAdd && add)) {
      const d = new Date()
      const v = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
      ;(instance as any)[this.attname] = v
      return v
    }
    return super.preSave(instance, add)
  }
  override toPython(value: unknown): string {
    if (value instanceof Date) {
      return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    }
    const s = String(value).trim()
    const m = TIME_RE.exec(s)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) {
      throw new ValidationError(`“${s}” value has an invalid format. It must be in HH:MM[:ss[.uuuuuu]] format.`, {
        code: 'invalid',
      })
    }
    const base = `${pad(Number(m[1]))}:${m[2]}:${m[3] ?? '00'}`
    return m[4] ? `${base}.${m[4]}` : base
  }
  override toDb(value: string | null | undefined): unknown {
    return value === null || value === undefined ? null : this.toPython(value)
  }
  override fromDb(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value)
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'time' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', format: 'time' }
  }
}

/** Durations in milliseconds (number), stored as bigint. */
export class DurationField<const O extends FieldOptions<number> = {}> extends Field<number, O> {
  static override readonly internalType: string = 'DurationField'
  override emptyStringsAllowed = false
  override toPython(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) throw new ValidationError(`“${String(value)}” value has an invalid duration.`, { code: 'invalid' })
    return Math.round(n)
  }
  override toDb(value: number | null | undefined): unknown {
    return value === null || value === undefined ? null : this.toPython(value)
  }
  override fromDb(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value)
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'number', step: 1, unit: 'ms' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'integer', description: 'Duration in milliseconds' }
  }
}

// ---- JSON & binary ------------------------------------------------------------------------------

/** Any JSON value. `text` in SQLite/D1, `jsonb` in PostgreSQL. SQL NULL is used for `null`. */
export class JSONField<J = any, const O extends FieldOptions<J> = {}> extends Field<J, O> {
  static override readonly internalType: string = 'JSONField'
  override emptyStringsAllowed = false
  override toPython(value: unknown): J {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as J
      } catch {
        return value as J
      }
    }
    return value as J
  }
  override toDb(value: J | null | undefined, _dialect?: Dialect): unknown {
    if (value === null || value === undefined) return null
    return JSON.stringify(value)
  }
  override dbParam(value: unknown, dialect: Dialect): Sql {
    const p = Sql.param(this.toDb(value as J, dialect))
    return dialect === 'postgresql' ? p.wrap('CAST(CAST(', ' AS text) AS jsonb)') : p
  }
  override fromDb(value: unknown, dialect: Dialect): J | null {
    if (value === null || value === undefined) return null
    if (dialect === 'sqlite' && typeof value === 'string') {
      try {
        return JSON.parse(value) as J
      } catch {
        return value as J
      }
    }
    return value as J
  }
  override validate(value: J | null | undefined, instance?: BaseModel): void {
    if (value !== null && value !== undefined) {
      try {
        JSON.stringify(value)
      } catch {
        throw new ValidationError('Value must be valid JSON.', { code: 'invalid' })
      }
    }
    super.validate(value, instance)
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'json' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return {}
  }
}

/** Raw bytes as `Uint8Array`. `blob` in SQLite/D1, `bytea` in PostgreSQL. */
export class BinaryField<const O extends FieldOptions<Uint8Array> = {}> extends Field<Uint8Array, O> {
  static override readonly internalType: string = 'BinaryField'
  override emptyStringsAllowed = false
  constructor(options: O = {} as O) {
    super({ editable: false, ...options } as O)
  }
  override toPython(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (Array.isArray(value)) return Uint8Array.from(value as number[])
    if (typeof value === 'string') {
      const bin = atob(value)
      return Uint8Array.from(bin, (c) => c.charCodeAt(0))
    }
    throw new ValidationError('Invalid binary value.', { code: 'invalid' })
  }
  override toDb(value: Uint8Array | null | undefined): unknown {
    return value === null || value === undefined ? null : this.toPython(value)
  }
  override fromDb(value: unknown): Uint8Array | null {
    if (value === null || value === undefined) return null
    if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return this.toPython(value)
  }
  override formHint(): FormHint {
    return this.withHintCommon({ widget: 'file' })
  }
  protected override baseJsonSchema(): Record<string, unknown> {
    return { type: 'string', contentEncoding: 'base64' }
  }
}
