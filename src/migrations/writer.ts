import type { Migration } from './migration'
import { isOperation, type Operation, RunCode } from './operations'

/** Maximum line width of generated migration files. */
export const LINE_WIDTH = 100
const INDENT = '  '

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function quote(s: string): string {
  const body = JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")
  return `'${body}'`
}

function key(k: string): string {
  return IDENT.test(k) ? k : quote(k)
}

/**
 * Serialize a value to TypeScript source (Django's `MigrationWriter.serialize`): JSON-like literals,
 * `Date`, `Uint8Array`, functions (their source) and operations (`ops.Name({...})`). Short values stay on one
 * line; longer ones are expanded with two-space indentation and trailing commas.
 */
export function serializeValue(value: unknown, indent = '', column = 0, expand = false): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  switch (typeof value) {
    case 'string':
      return quote(value)
    case 'number':
      if (Number.isNaN(value)) return 'Number.NaN'
      if (!Number.isFinite(value)) return value > 0 ? 'Number.POSITIVE_INFINITY' : 'Number.NEGATIVE_INFINITY'
      return String(value)
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value}n`
    case 'function':
      return reindent(value.toString(), indent)
    case 'symbol':
      throw new TypeError(`Cannot serialize symbol ${String(value)} in a migration.`)
  }
  if (value instanceof Date) return `new Date(${quote(value.toISOString())})`
  if (value instanceof Uint8Array) return `new Uint8Array([${[...value].join(', ')}])`
  if (isOperation(value)) return serializeOperation(value, indent, column)
  if (Array.isArray(value)) {
    const inner = indent + INDENT
    const items = value.map((v) => serializeValue(v, inner, inner.length))
    const inline = `[${items.join(', ')}]`
    if (!expand && fits(inline, column)) return inline
    if (!items.length) return '[]'
    return `[\n${items.map((i) => `${inner}${i},`).join('\n')}\n${indent}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (!entries.length) return '{}'
    const inner = indent + INDENT
    const parts = entries.map(([k, v]) => {
      const p = `${key(k)}: `
      return p + serializeValue(v, inner, inner.length + p.length)
    })
    const inline = `{ ${parts.join(', ')} }`
    if (!expand && fits(inline, column)) return inline
    return `{\n${parts.map((p) => `${inner}${p},`).join('\n')}\n${indent}}`
  }
  throw new TypeError(`Cannot serialize ${String(value)} in a migration.`)
}

function fits(inline: string, column: number): boolean {
  return !inline.includes('\n') && column + inline.length + 2 <= LINE_WIDTH
}

function reindent(src: string, indent: string): string {
  const lines = src.split('\n')
  if (lines.length === 1) return src
  const rest = lines.slice(1)
  const min = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
  const base = Number.isFinite(min) ? min : 0
  const closing = rest[rest.length - 1].match(/^\s*/)![0].length
  const shift = Math.min(base, closing)
  return [lines[0], ...rest.map((l) => (l.trim() ? indent + l.slice(shift) : ''))].join('\n')
}

/** Expand these keys of operation options even when they would fit on one line. */
const ALWAYS_EXPAND = new Set(['fields'])

/** `ops.CreateModel({ … })` */
export function serializeOperation(op: Operation, indent = '', column = 0): string {
  const head = `ops.${op.type}(`
  if (op instanceof RunCode) {
    const args = [serializeValue(op.code, indent, column)]
    if (op.reverseCode)
      args.push(op.reverseCode === RunCode.noop ? 'ops.RunCode.noop' : serializeValue(op.reverseCode, indent))
    return `${head}${args.join(', ')})`
  }
  const opts = op.deconstruct()
  const inner = indent + INDENT
  const parts = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const p = `${key(k)}: `
      return p + serializeValue(v, inner, inner.length + p.length, ALWAYS_EXPAND.has(k))
    })
  const inline = `${head}{ ${parts.join(', ')} })`
  if (fits(inline, column)) return inline
  return `${head}{\n${parts.map((p) => `${inner}${p},`).join('\n')}\n${indent}})`
}

export interface MigrationWriterOptions {
  /** Module the migration imports from (default `@ghuri/orm/migrations`). */
  importFrom?: string
  /** Header comment (default: generated-by line with the date). */
  header?: string | null
}

/** Renders a `Migration` as a TypeScript module (Django's `MigrationWriter`). */
export class MigrationWriter {
  constructor(
    readonly migration: Migration,
    readonly opts: MigrationWriterOptions = {},
  ) {}

  get filename(): string {
    return `${this.migration.name}.ts`
  }

  asString(): string {
    const m = this.migration
    const lines: string[] = []
    const header =
      this.opts.header === undefined
        ? `// Generated by Ghuri makemigrations on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
        : this.opts.header
    if (header) lines.push(header)
    const usesOps = m.operations.length > 0
    const imports = usesOps ? '{ Migration, operations as ops }' : '{ Migration }'
    lines.push(`import ${imports} from '${this.opts.importFrom ?? '@ghuri/orm/migrations'}'`, '')
    const body: string[] = []
    const inner = INDENT
    if (m.initial) body.push(`${inner}initial: true,`)
    if (m.replaces.length)
      body.push(
        `${inner}replaces: ${serializeValue(
          m.replaces.map((r) => [...r]),
          inner,
          12,
        )},`,
      )
    body.push(
      `${inner}dependencies: ${serializeValue(
        m.dependencies.map((d) => [...d]),
        inner,
        16,
      )},`,
    )
    if (m.atomic === false) body.push(`${inner}atomic: false,`)
    if (m.runBefore.length)
      body.push(
        `${inner}runBefore: ${serializeValue(
          m.runBefore.map((r) => [...r]),
          inner,
          13,
        )},`,
      )
    if (m.operations.length) {
      const opIndent = inner + INDENT
      const ops = m.operations.map((op) => `${opIndent}${serializeOperation(op, opIndent, opIndent.length)},`)
      body.push(`${inner}operations: [\n${ops.join('\n')}\n${inner}],`)
    } else {
      body.push(`${inner}operations: [],`)
    }
    lines.push('export default new Migration({', ...body, '})', '')
    return lines.join('\n')
  }
}

/** Identifier exported for a migration in `migrations/index.ts` (`0001_initial` → `m0001_initial`). */
export function migrationExportName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_$]/g, '_')
  return /^[0-9]/.test(safe) ? `m${safe}` : safe
}

/**
 * `migrations/index.ts` exporting every migration (so `AppConfig.migrations = import * as migrations from
 * './migrations'` works on Workers, without file system access).
 */
export function migrationsIndexSource(names: string[]): string {
  const sorted = [...names].sort()
  const lines = ['// Generated by Ghuri makemigrations: every migration of this app, in order. Do not edit.']
  if (!sorted.length) {
    lines.push('', 'export const migrations = {}', '')
    return lines.join('\n')
  }
  for (const n of sorted) lines.push(`import ${migrationExportName(n)} from './${n}'`)
  lines.push('', `export { ${sorted.map(migrationExportName).join(', ')} }`)
  const exportLine = lines[lines.length - 1]
  if (exportLine.length > LINE_WIDTH) {
    lines[lines.length - 1] = `export {\n${sorted.map((n) => `  ${migrationExportName(n)},`).join('\n')}\n}`
  }
  lines.push('', '/** Every migration of this app by name, in order. */', 'export const migrations = {')
  for (const n of sorted) lines.push(`  ${quote(n)}: ${migrationExportName(n)},`)
  lines.push('}', '')
  return lines.join('\n')
}
