/**
 * Tiny dialect-neutral SQL builder. Fragments are lists of raw strings and parameters; rendering turns
 * parameters into `?` (SQLite/D1) or `$n` (PostgreSQL). Identifiers are quoted with double quotes, which
 * both dialects accept. This is the single compilation target of the QuerySet compiler and the schema
 * editor; drivers only ever receive `(sql, params)`.
 */
export type Dialect = 'sqlite' | 'postgresql'

export class Param {
  constructor(readonly value: unknown) {}
}

type Chunk = string | Param

export class Sql {
  /** True when the fragment contains an aggregate function (decides WHERE vs HAVING). */
  containsAggregate = false

  constructor(readonly chunks: Chunk[] = []) {}

  static raw(text: string): Sql {
    return new Sql([text])
  }

  static param(value: unknown): Sql {
    return new Sql([new Param(value)])
  }

  static join(parts: Array<Sql | string>, sep = ', '): Sql {
    const out = new Sql()
    parts.forEach((p, i) => {
      if (i > 0 && sep) out.chunks.push(sep)
      out.append(p)
    })
    return out
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0
  }

  append(part: Sql | string): this {
    if (typeof part === 'string') this.chunks.push(part)
    else {
      this.chunks.push(...part.chunks)
      if (part.containsAggregate) this.containsAggregate = true
    }
    return this
  }

  wrap(before: string, after: string): Sql {
    const s = new Sql([before, ...this.chunks, after])
    s.containsAggregate = this.containsAggregate
    return s
  }

  markAggregate(flag = true): this {
    if (flag) this.containsAggregate = true
    return this
  }

  render(dialect: Dialect): { sql: string; params: unknown[] } {
    const params: unknown[] = []
    let text = ''
    for (const c of this.chunks) {
      if (typeof c === 'string') text += c
      else {
        params.push(c.value)
        text += dialect === 'postgresql' ? `$${params.length}` : '?'
      }
    }
    return { sql: text, params }
  }

  /** Debug representation with parameters inlined (never execute this). */
  toString(): string {
    let text = ''
    for (const c of this.chunks) text += typeof c === 'string' ? c : literal(c.value)
    return text
  }
}

/** Tagged template: interpolated `Sql` values are inlined, anything else becomes a parameter. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  const out = new Sql()
  strings.forEach((s, i) => {
    if (s) out.chunks.push(s)
    if (i < values.length) {
      const v = values[i]
      if (v instanceof Sql) out.append(v)
      else out.chunks.push(new Param(v))
    }
  })
  return out
}

export function quoteName(name: string): string {
  if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) return name
  return `"${name.replace(/"/g, '""')}"`
}

export function ident(...parts: string[]): Sql {
  return Sql.raw(parts.map(quoteName).join('.'))
}

/** SQL literal for DDL defaults and debugging. */
export function literal(value: unknown, dialect: Dialect = 'sqlite'): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean')
    return dialect === 'postgresql' ? (value ? 'true' : 'false') : value ? '1' : '0'
  if (value instanceof Date) return `'${value.toISOString()}'`
  if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`
  return `'${String(value).replace(/'/g, "''")}'`
}
