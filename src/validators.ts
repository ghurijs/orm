import { ValidationError } from '@ghuri/core'

/**
 * A validator is either a function that throws `ValidationError`, or an object with `validate(value)`.
 * Class validators (`new MaxLengthValidator(10)`) also expose `deconstruct()` for migrations.
 */
export type ValidatorFn = (value: any) => void
export type Validator = ValidatorFn | { validate(value: any): void; deconstruct?(): unknown }

export function runValidator(v: Validator, value: unknown): void {
  if (typeof v === 'function') v(value)
  else v.validate(value)
}

function fmt(message: string, params: Record<string, unknown>): string {
  return message.replace(/%\((\w+)\)s/g, (_, k) => String(params[k]))
}

export abstract class BaseValidator {
  abstract readonly code: string
  abstract message: string
  constructor(readonly limitValue: any) {}
  protected clean(value: any): any {
    return value
  }
  protected abstract compare(a: any, b: any): boolean
  validate(value: unknown): void {
    const cleaned = this.clean(value)
    const limit = typeof this.limitValue === 'function' ? this.limitValue() : this.limitValue
    if (this.compare(cleaned, limit)) {
      throw new ValidationError(fmt(this.message, { limitValue: limit, showValue: cleaned, value }), {
        code: this.code,
      })
    }
  }
  deconstruct(): { type: string; args: unknown[] } {
    return { type: this.constructor.name, args: [this.limitValue] }
  }
}

export class MaxValueValidator extends BaseValidator {
  readonly code = 'max_value'
  message = 'Ensure this value is less than or equal to %(limitValue)s.'
  protected compare(a: any, b: any): boolean {
    return Number(a) > Number(b)
  }
}

export class MinValueValidator extends BaseValidator {
  readonly code = 'min_value'
  message = 'Ensure this value is greater than or equal to %(limitValue)s.'
  protected compare(a: any, b: any): boolean {
    return Number(a) < Number(b)
  }
}

export class MinLengthValidator extends BaseValidator {
  readonly code = 'min_length'
  message = 'Ensure this value has at least %(limitValue)s characters (it has %(showValue)s).'
  protected override clean(value: any): number {
    return [...String(value ?? '')].length
  }
  protected compare(a: number, b: number): boolean {
    return a < b
  }
}

export class MaxLengthValidator extends BaseValidator {
  readonly code = 'max_length'
  message = 'Ensure this value has at most %(limitValue)s characters (it has %(showValue)s).'
  protected override clean(value: any): number {
    return [...String(value ?? '')].length
  }
  protected compare(a: number, b: number): boolean {
    return a > b
  }
}

export class RegexValidator {
  readonly regex: RegExp
  message: string
  code: string
  inverseMatch: boolean
  constructor(
    regex: RegExp | string,
    opts: { message?: string; code?: string; inverseMatch?: boolean; flags?: string } = {},
  ) {
    this.regex = typeof regex === 'string' ? new RegExp(regex, opts.flags) : regex
    this.message = opts.message ?? 'Enter a valid value.'
    this.code = opts.code ?? 'invalid'
    this.inverseMatch = opts.inverseMatch ?? false
  }
  validate(value: unknown): void {
    const matches = this.regex.test(String(value ?? ''))
    if (this.inverseMatch ? matches : !matches) throw new ValidationError(this.message, { code: this.code })
  }
  deconstruct(): { type: string; args: unknown[] } {
    return {
      type: 'RegexValidator',
      args: [this.regex.source, { message: this.message, code: this.code, inverseMatch: this.inverseMatch, flags: this.regex.flags }],
    }
  }
}

const EMAIL_RE =
  /^(?!\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$|^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@localhost$|^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@\[[0-9a-fA-F:.]+\]$/

export class EmailValidator {
  message: string
  code = 'invalid'
  allowlist: string[]
  constructor(opts: { message?: string; allowlist?: string[] } = {}) {
    this.message = opts.message ?? 'Enter a valid email address.'
    this.allowlist = opts.allowlist ?? ['localhost']
  }
  validate(value: unknown): void {
    const s = String(value ?? '')
    if (!s || s.length > 320 || !s.includes('@')) throw new ValidationError(this.message, { code: this.code })
    const domain = s.slice(s.lastIndexOf('@') + 1)
    if (this.allowlist.includes(domain) && /^[^@\s]+@[^@\s]+$/.test(s)) return
    if (!EMAIL_RE.test(s)) throw new ValidationError(this.message, { code: this.code })
  }
  deconstruct(): { type: string; args: unknown[] } {
    return { type: 'EmailValidator', args: [] }
  }
}

export class URLValidator {
  message: string
  code = 'invalid'
  schemes: string[]
  constructor(opts: { schemes?: string[]; message?: string } = {}) {
    this.schemes = opts.schemes ?? ['http', 'https', 'ftp', 'ftps']
    this.message = opts.message ?? 'Enter a valid URL.'
  }
  validate(value: unknown): void {
    const s = String(value ?? '')
    if (!s || s.length > 2048 || /\s/.test(s)) throw new ValidationError(this.message, { code: this.code })
    let url: URL
    try {
      url = new URL(s)
    } catch {
      throw new ValidationError(this.message, { code: this.code })
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase()
    if (!this.schemes.includes(scheme) || !url.hostname) throw new ValidationError(this.message, { code: this.code })
    const host = url.hostname
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
    if (!isIp && host !== 'localhost' && !/^([a-z0-9¡-￿-]+\.)+[a-z¡-￿-]{2,63}\.?$/i.test(host)) {
      throw new ValidationError(this.message, { code: this.code })
    }
  }
  deconstruct(): { type: string; args: unknown[] } {
    return { type: 'URLValidator', args: [] }
  }
}

const SLUG_RE = /^[-a-zA-Z0-9_]+$/
const UNICODE_SLUG_RE = /^[-\p{L}\p{N}_]+$/u

export const validateSlug: ValidatorFn = (value) => {
  if (!SLUG_RE.test(String(value ?? ''))) {
    throw new ValidationError(
      'Enter a valid “slug” consisting of letters, numbers, underscores or hyphens.',
      { code: 'invalid' },
    )
  }
}

export const validateUnicodeSlug: ValidatorFn = (value) => {
  if (!UNICODE_SLUG_RE.test(String(value ?? ''))) {
    throw new ValidationError(
      'Enter a valid “slug” consisting of Unicode letters, numbers, underscores, or hyphens.',
      { code: 'invalid' },
    )
  }
}

export const validateEmail: ValidatorFn = (value) => new EmailValidator().validate(value)
export const validateURL: ValidatorFn = (value) => new URLValidator().validate(value)

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function isIPv4(s: string): boolean {
  return IPV4_RE.test(s)
}

export function isIPv6(s: string): boolean {
  if (!s.includes(':')) return false
  try {
    return new URL(`http://[${s}]/`).hostname.length > 0
  } catch {
    return false
  }
}

export const validateIPv4Address: ValidatorFn = (value) => {
  if (!isIPv4(String(value ?? ''))) throw new ValidationError('Enter a valid IPv4 address.', { code: 'invalid' })
}
export const validateIPv6Address: ValidatorFn = (value) => {
  if (!isIPv6(String(value ?? ''))) throw new ValidationError('Enter a valid IPv6 address.', { code: 'invalid' })
}
export const validateIPv46Address: ValidatorFn = (value) => {
  const s = String(value ?? '')
  if (!isIPv4(s) && !isIPv6(s)) throw new ValidationError('Enter a valid IPv4 or IPv6 address.', { code: 'invalid' })
}

export class DecimalValidator {
  code = 'invalid'
  constructor(
    readonly maxDigits: number | undefined,
    readonly decimalPlaces: number | undefined,
  ) {}
  validate(value: unknown): void {
    const s = String(value ?? '').replace(/^[-+]/, '')
    if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') {
      throw new ValidationError('Enter a number.', { code: 'invalid' })
    }
    const [intPart, frac = ''] = s.split('.')
    const whole = intPart.replace(/^0+/, '')
    const decimals = frac.replace(/0+$/, '').length
    const digits = whole.length + decimals
    if (this.maxDigits !== undefined && digits > this.maxDigits) {
      throw new ValidationError(`Ensure that there are no more than ${this.maxDigits} digits in total.`, {
        code: 'max_digits',
      })
    }
    if (this.decimalPlaces !== undefined && decimals > this.decimalPlaces) {
      throw new ValidationError(`Ensure that there are no more than ${this.decimalPlaces} decimal places.`, {
        code: 'max_decimal_places',
      })
    }
    if (
      this.maxDigits !== undefined &&
      this.decimalPlaces !== undefined &&
      whole.length > this.maxDigits - this.decimalPlaces
    ) {
      throw new ValidationError(
        `Ensure that there are no more than ${this.maxDigits - this.decimalPlaces} digits before the decimal point.`,
        { code: 'max_whole_digits' },
      )
    }
  }
}

export class ProhibitNullCharactersValidator {
  code = 'null_characters_not_allowed'
  validate(value: unknown): void {
    if (String(value ?? '').includes('\u0000')) {
      throw new ValidationError('Null characters are not allowed.', { code: this.code })
    }
  }
}
