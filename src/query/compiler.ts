import type { DatabaseFeatures } from '../db/types'
import { FieldError, NotSupportedError } from '../errors'
import type { Field } from '../fields/base'
import { ForeignKey, ManyToManyField, RelatedObject } from '../fields/related'
import { DateField, IntegerField } from '../fields/scalar'
import type { BaseModel, ModelClass } from '../models/types'
import { LOOKUP_SEP } from '../utils'
import { type Aggregate, type CompileScope, Expression, OrderBy, QNode } from './expressions'
import { type Dialect, ident, Sql, sql } from './sql'

// ---- query state --------------------------------------------------------------------------------

export interface ValuesSpec {
  kind: 'dict' | 'list' | 'flat' | 'named'
  fields: string[]
  /** Annotations with index >= this are always included (added after values()). */
  annotationStart: number
}

export interface PrefetchLike {
  lookup: string
  queryset?: { state: QueryState }
  toAttr?: string
}

/** Immutable description of a query; QuerySet clones it on every chained call. */
export interface QueryState {
  model: ModelClass
  where: QNode[]
  annotations: Array<[string, Expression]>
  /** null → model's default ordering. */
  ordering: Array<string | OrderBy> | null
  reversed: boolean
  distinct: boolean
  low: number
  high: number | null
  selectRelated: string[] | true | null
  prefetch: Array<string | PrefetchLike>
  /** only(): load just these; defer(): skip these. */
  loadFields: { names: string[]; mode: 'only' | 'defer' } | null
  values: ValuesSpec | null
  /** values() fields active when an aggregate annotation was added → GROUP BY. */
  groupBy: string[] | null
  isNone: boolean
  using?: string
}

export function emptyState(model: ModelClass): QueryState {
  return {
    model,
    where: [],
    annotations: [],
    ordering: null,
    reversed: false,
    distinct: false,
    low: 0,
    high: null,
    selectRelated: null,
    prefetch: [],
    loadFields: null,
    values: null,
    groupBy: null,
    isNone: false,
  }
}

export function isSliced(state: QueryState): boolean {
  return state.low > 0 || state.high !== null
}

// ---- compiler & scopes --------------------------------------------------------------------------

export class Compiler {
  private n = 0
  constructor(
    readonly dialect: Dialect,
    readonly features?: DatabaseFeatures,
  ) {}
  nextAlias(): string {
    return `T${this.n++}`
  }
}

export interface PathEntry {
  alias: string | null
  model: ModelClass
  scope: Scope
}

type Resolved =
  | { kind: 'column'; entry: PathEntry; field: Field<any, any>; rest: string[] }
  | { kind: 'annotation'; name: string; expr: Expression; rest: string[] }
  | {
      kind: 'multi'
      prefixKey: string
      from: PathEntry
      rel: RelatedObject | ManyToManyField
      reverseM2M: boolean
      rest: string[]
    }

interface Hop {
  from: Sql
  correlate: Sql
  target: PathEntry
}

const TEXT_TYPES = new Set([
  'CharField',
  'TextField',
  'SlugField',
  'EmailField',
  'URLField',
  'GenericIPAddressField',
])

export const LOOKUPS = new Set([
  'exact',
  'iexact',
  'contains',
  'icontains',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'startswith',
  'istartswith',
  'endswith',
  'iendswith',
  'range',
  'isnull',
  'regex',
  'iregex',
])
export const TRANSFORMS = new Set([
  'date',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'week_day',
  'quarter',
  'time',
])

function isModelInstance(v: unknown): v is BaseModel {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as any).constructor?._meta === 'object' &&
    '_state' in (v as object)
  )
}

function isQuerySetLike(v: unknown): v is { state: QueryState; _isQuerySet: true } {
  return !!v && typeof v === 'object' && (v as any)._isQuerySet === true
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
function globEscape(s: string): string {
  return s.replace(/[*?[]/g, (c) => `[${c}]`)
}

/** Field for a path without creating joins (output types, conversions). */
export function fieldAtPath(model: ModelClass, parts: string[]): Field<any, any> | undefined {
  let m = model
  for (let i = 0; i < parts.length; i++) {
    const f = m._meta.findField(parts[i])
    if (!f) return undefined
    const last = i === parts.length - 1
    if (f instanceof RelatedObject) {
      m = f.relatedModel
      if (last) return m._meta.pk
      continue
    }
    if (f instanceof ManyToManyField) {
      m = f.relatedModel
      if (last) return m._meta.pk
      continue
    }
    if (f instanceof ForeignKey && !last && parts[i] === f.name) {
      const next = parts[i + 1]
      if (!f.relatedModel._meta.findField(next)) return f
      m = f.relatedModel
      continue
    }
    return f
  }
  return undefined
}

/**
 * A FROM-clause scope: the root query, or a correlated subquery (EXISTS for multi-valued filters,
 * scalar subqueries for aggregate annotations). Paths (`author__profile`) map to table aliases; joins
 * are added to the scope that owns the path's parent.
 */
export class Scope implements CompileScope {
  readonly joins: Sql[] = []
  readonly paths = new Map<string, PathEntry>()
  readonly annotations = new Map<string, Expression>()
  /** Multi-valued relations become LEFT JOINs instead of subqueries (values/ordering/grouped aggregates). */
  allowMultiJoins = false
  /** Aggregates over multi-valued paths use joins (GROUP BY queries, aggregate()). */
  aggregateJoins = false
  /** UPDATE mode: no joins, unqualified columns. */
  noJoins = false

  constructor(
    readonly compiler: Compiler,
    readonly parent?: Scope,
  ) {}

  /** A root scope for `model` with base alias. */
  static root(compiler: Compiler, model: ModelClass, alias: string | null = compiler.nextAlias()): Scope {
    const s = new Scope(compiler)
    s.paths.set('', { alias, model, scope: s })
    return s
  }

  get dialect(): Dialect {
    return this.compiler.dialect
  }

  get rootEntry(): PathEntry {
    const e = this.lookupPath('')
    if (!e) throw new Error('scope without root')
    return e
  }

  lookupPath(key: string): PathEntry | undefined {
    return this.paths.get(key) ?? this.parent?.lookupPath(key)
  }

  findAnnotation(name: string): Expression | undefined {
    return this.annotations.get(name) ?? this.parent?.findAnnotation(name)
  }

  col(entry: PathEntry, column: string): Sql {
    return entry.alias === null ? ident(column) : ident(entry.alias, column)
  }

  // ---- joins ------------------------------------------------------------------------------------

  private ensureJoinsAllowed(owner: Scope): void {
    if (owner.noJoins) throw new FieldError('Joined field references are not permitted in this query.')
  }

  private joinForward(entry: PathEntry, key: string, fk: ForeignKey): PathEntry {
    const existing = this.lookupPath(key)
    if (existing) return existing
    const owner = entry.scope
    this.ensureJoinsAllowed(owner)
    const target = fk.relatedModel
    const alias = this.compiler.nextAlias()
    owner.joins.push(
      sql`LEFT JOIN ${ident(target._meta.dbTable)} AS ${ident(alias)} ON ${ident(alias, fk.targetField.column)} = ${this.col(entry, fk.column)}`,
    )
    const e: PathEntry = { alias, model: target, scope: owner }
    owner.paths.set(key, e)
    return e
  }

  private joinReverse(entry: PathEntry, key: string, rel: RelatedObject): PathEntry {
    const existing = this.lookupPath(key)
    if (existing) return existing
    const owner = entry.scope
    this.ensureJoinsAllowed(owner)
    const fk = rel.field as ForeignKey
    const alias = this.compiler.nextAlias()
    owner.joins.push(
      sql`LEFT JOIN ${ident(rel.relatedModel._meta.dbTable)} AS ${ident(alias)} ON ${ident(alias, fk.column)} = ${this.col(entry, fk.targetField.column)}`,
    )
    const e: PathEntry = { alias, model: rel.relatedModel, scope: owner }
    owner.paths.set(key, e)
    return e
  }

  private m2mSides(
    field: ManyToManyField,
    reverse: boolean,
  ): { src: ForeignKey; tgt: ForeignKey; target: ModelClass } {
    const [a, b] = field.throughFieldNames()
    const meta = field.through._meta
    const fa = meta.getForwardField(a) as ForeignKey
    const fb = meta.getForwardField(b) as ForeignKey
    return reverse
      ? { src: fb, tgt: fa, target: field.model }
      : { src: fa, tgt: fb, target: field.relatedModel }
  }

  private joinM2M(entry: PathEntry, key: string, field: ManyToManyField, reverse: boolean): PathEntry {
    const existing = this.lookupPath(key)
    if (existing) return existing
    const owner = entry.scope
    this.ensureJoinsAllowed(owner)
    const { src, tgt, target } = this.m2mSides(field, reverse)
    const th = this.compiler.nextAlias()
    const tg = this.compiler.nextAlias()
    owner.joins.push(
      sql`LEFT JOIN ${ident(field.through._meta.dbTable)} AS ${ident(th)} ON ${ident(th, src.column)} = ${this.col(entry, src.targetField.column)}`,
    )
    owner.joins.push(
      sql`LEFT JOIN ${ident(target._meta.dbTable)} AS ${ident(tg)} ON ${ident(tg, tgt.targetField.column)} = ${ident(th, tgt.column)}`,
    )
    const e: PathEntry = { alias: tg, model: target, scope: owner }
    owner.paths.set(key, e)
    return e
  }

  /** FROM + correlation of a subquery over a multi-valued hop; seeds `prefixKey` in `sub`. */
  private buildHop(sub: Scope, r: Extract<Resolved, { kind: 'multi' }>): Hop {
    if (r.rel instanceof ManyToManyField) {
      const { src, tgt, target } = this.m2mSides(r.rel, r.reverseM2M)
      const th = this.compiler.nextAlias()
      const tg = this.compiler.nextAlias()
      const from = sql`${ident(r.rel.through._meta.dbTable)} AS ${ident(th)} INNER JOIN ${ident(target._meta.dbTable)} AS ${ident(tg)} ON ${ident(tg, tgt.targetField.column)} = ${ident(th, tgt.column)}`
      const correlate = sql`${ident(th, src.column)} = ${this.col(r.from, src.targetField.column)}`
      const entry: PathEntry = { alias: tg, model: target, scope: sub }
      sub.paths.set(r.prefixKey, entry)
      return { from, correlate, target: entry }
    }
    const rel = r.rel
    const fk = rel.field as ForeignKey
    const alias = this.compiler.nextAlias()
    const from = sql`${ident(rel.relatedModel._meta.dbTable)} AS ${ident(alias)}`
    const correlate = sql`${ident(alias, fk.column)} = ${this.col(r.from, fk.targetField.column)}`
    const entry: PathEntry = { alias, model: rel.relatedModel, scope: sub }
    sub.paths.set(r.prefixKey, entry)
    return { from, correlate, target: entry }
  }

  // ---- path resolution --------------------------------------------------------------------------

  resolvePath(parts: string[], opts: { allowMulti?: boolean } = {}): Resolved {
    const allowMulti = opts.allowMulti ?? this.allowMultiJoins
    const ann = this.findAnnotation(parts[0])
    let entry = this.rootEntry
    if (ann && !entry.model._meta.findField(parts[0])) {
      return { kind: 'annotation', name: parts[0], expr: ann, rest: parts.slice(1) }
    }
    let key = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const model = entry.model
      const meta = model._meta
      const f = meta.findField(part)
      if (!f) {
        if (i === 0) {
          throw new FieldError(
            `Cannot resolve keyword '${part}' into field. Choices are: ${[...meta.lookupNames(), ...this.annotationNames()].join(', ')}`,
          )
        }
        throw new FieldError(`Unsupported lookup or field '${part}' in '${parts.join(LOOKUP_SEP)}'.`)
      }
      const newKey = key ? `${key}${LOOKUP_SEP}${part}` : part
      const next = parts[i + 1]
      const nextIsField = (m: ModelClass) => next !== undefined && !!m._meta.findField(next)

      if (f instanceof RelatedObject) {
        if (f.oneToOne) {
          entry = this.joinReverse(entry, newKey, f)
          key = newKey
          if (!nextIsField(entry.model))
            return { kind: 'column', entry, field: entry.model._meta.pk, rest: parts.slice(i + 1) }
          continue
        }
        const m2m = f.manyToMany
        const existing = this.lookupPath(newKey)
        if (existing || allowMulti) {
          entry =
            existing ??
            (m2m
              ? this.joinM2M(entry, newKey, f.field as ManyToManyField, true)
              : this.joinReverse(entry, newKey, f))
          key = newKey
          if (!nextIsField(entry.model))
            return { kind: 'column', entry, field: entry.model._meta.pk, rest: parts.slice(i + 1) }
          continue
        }
        return {
          kind: 'multi',
          prefixKey: newKey,
          from: entry,
          rel: m2m ? (f.field as ManyToManyField) : f,
          reverseM2M: m2m,
          rest: parts.slice(i + 1),
        }
      }
      if (f instanceof ManyToManyField) {
        const existing = this.lookupPath(newKey)
        if (existing || allowMulti) {
          entry = existing ?? this.joinM2M(entry, newKey, f, false)
          key = newKey
          if (!nextIsField(entry.model))
            return { kind: 'column', entry, field: entry.model._meta.pk, rest: parts.slice(i + 1) }
          continue
        }
        return {
          kind: 'multi',
          prefixKey: newKey,
          from: entry,
          rel: f,
          reverseM2M: false,
          rest: parts.slice(i + 1),
        }
      }
      if (f instanceof ForeignKey && part === f.name) {
        const target = f.relatedModel
        if (!nextIsField(target)) return { kind: 'column', entry, field: f, rest: parts.slice(i + 1) }
        // author__id → the FK column itself, no join needed
        if (next === 'pk' || next === f.targetField.name) {
          const after = parts[i + 2]
          if (after === undefined || !target._meta.findField(after)) {
            return { kind: 'column', entry, field: f, rest: parts.slice(i + 2) }
          }
        }
        entry = this.joinForward(entry, newKey, f)
        key = newKey
        continue
      }
      return { kind: 'column', entry, field: f as Field<any, any>, rest: parts.slice(i + 1) }
    }
    return { kind: 'column', entry, field: entry.model._meta.pk, rest: [] }
  }

  private annotationNames(): string[] {
    const names = [...this.annotations.keys()]
    return this.parent ? [...names, ...this.parent.annotationNames()] : names
  }

  // ---- CompileScope -----------------------------------------------------------------------------

  compileRef(name: string): Sql {
    const r = this.resolvePath(name.split(LOOKUP_SEP), { allowMulti: true })
    if (r.kind === 'annotation') {
      if (r.rest.length) throw new FieldError(`Cannot use lookups in a reference: '${name}'.`)
      return r.expr.compile(this)
    }
    if (r.kind !== 'column' || r.rest.length) throw new FieldError(`Cannot resolve expression '${name}'.`)
    return this.col(r.entry, r.field.column)
  }

  refField(name: string): Field<any, any> | undefined {
    const parts = name.split(LOOKUP_SEP)
    const ann = this.findAnnotation(parts[0])
    if (ann && parts.length === 1 && !this.rootEntry.model._meta.findField(parts[0]))
      return ann.outputField(this)
    return fieldAtPath(this.rootEntry.model, parts)
  }

  compileValue(value: unknown, field?: Field<any, any>): Sql {
    if (value instanceof Expression) return value.compile(this)
    if (field) return field.dbParam(field.getPrepValue(value), this.dialect)
    if (this.dialect === 'postgresql') {
      // Untyped parameters would be inferred as text: give literals an explicit type.
      if (value instanceof Date) return Sql.param(value.toISOString()).wrap('CAST(', ' AS timestamptz)')
      if (typeof value === 'boolean') return Sql.param(value).wrap('CAST(', ' AS boolean)')
      if (typeof value === 'number')
        return Sql.param(value).wrap(
          'CAST(',
          Number.isInteger(value) ? ' AS bigint)' : ' AS double precision)',
        )
      if (typeof value === 'string') return Sql.param(value).wrap('CAST(', ' AS text)')
      return Sql.param(value)
    }
    if (value instanceof Date) return Sql.param(value.toISOString())
    if (typeof value === 'boolean') return Sql.param(value ? 1 : 0)
    return Sql.param(value)
  }

  compileAggregate(agg: Aggregate): Sql {
    const fn = agg.fn
    const distinct = agg.distinct ? 'DISTINCT ' : ''
    if (agg.source === '*') {
      if (agg.filter) {
        const cond = this.compileQ(agg.filter)
        return new Sql([`${fn}(CASE WHEN `]).append(cond).append(' THEN 1 ELSE NULL END)').markAggregate()
      }
      return Sql.raw(`${fn}(*)`).markAggregate()
    }
    if (agg.source instanceof Expression) {
      const inner = agg.source.compile(this)
      return this.wrapAggregate(fn, distinct, inner, agg.filter ? this.compileQ(agg.filter) : undefined)
    }
    const parts = agg.source.split(LOOKUP_SEP)
    const r = this.resolvePath(parts, { allowMulti: this.aggregateJoins })
    if (r.kind === 'annotation') {
      return this.wrapAggregate(
        fn,
        distinct,
        r.expr.compile(this),
        agg.filter ? this.compileQ(agg.filter) : undefined,
      )
    }
    if (r.kind === 'multi') {
      // Correlated scalar subquery: no row multiplication, no GROUP BY needed.
      const sub = new Scope(this.compiler, this)
      sub.allowMultiJoins = true
      sub.aggregateJoins = true
      const hop = this.buildHop(sub, r)
      const r2 = sub.resolvePath(parts, { allowMulti: true })
      if (r2.kind !== 'column' || r2.rest.length)
        throw new FieldError(`Cannot aggregate over '${agg.source}'.`)
      const inner = sub.col(r2.entry, r2.field.column)
      const where = [hop.correlate]
      if (agg.filter) where.push(sub.compileQ(agg.filter))
      const body = new Sql([`${fn}(${distinct}`]).append(inner).append(')')
      const out = new Sql(['(SELECT ']).append(body).append(' FROM ').append(hop.from)
      for (const j of sub.joins) out.append(' ').append(j)
      out.append(' WHERE ').append(Sql.join(where, ' AND ')).append(')')
      out.containsAggregate = false
      return out
    }
    if (r.rest.length) throw new FieldError(`Cannot aggregate over '${agg.source}'.`)
    const inner = this.col(r.entry, r.field.column)
    return this.wrapAggregate(fn, distinct, inner, agg.filter ? this.compileQ(agg.filter) : undefined)
  }

  private wrapAggregate(fn: string, distinct: string, inner: Sql, filter?: Sql): Sql {
    const arg = filter
      ? new Sql(['CASE WHEN ']).append(filter).append(' THEN ').append(inner).append(' ELSE NULL END')
      : inner
    const out = new Sql([`${fn}(${distinct}`]).append(arg).append(')')
    out.containsAggregate = true
    return out
  }

  // ---- WHERE ------------------------------------------------------------------------------------

  compileQ(q: QNode): Sql {
    const parts: Sql[] = []
    if (q.connector === 'AND') {
      const groups = new Map<
        string,
        { r: Extract<Resolved, { kind: 'multi' }>; leaves: Array<[string, unknown]> }
      >()
      for (const child of q.children) {
        if (child instanceof QNode) {
          const s = this.compileQ(child)
          if (!s.isEmpty) parts.push(s)
          continue
        }
        const [key, value] = child
        const r = this.resolvePath(key.split(LOOKUP_SEP), { allowMulti: false })
        if (r.kind === 'multi' && !(r.rest.length === 1 && r.rest[0] === 'isnull')) {
          const g = groups.get(r.prefixKey)
          if (g) g.leaves.push([key, value])
          else groups.set(r.prefixKey, { r, leaves: [[key, value]] })
          // keep position: placeholder replaced below
          parts.push(Sql.raw(`\u0000${r.prefixKey}`))
          continue
        }
        parts.push(this.compileResolvedLeaf(r, key, value))
      }
      // Replace the first placeholder of each group with its EXISTS; drop the rest.
      const seen = new Set<string>()
      const final: Sql[] = []
      for (const p of parts) {
        const c = p.chunks[0]
        if (p.chunks.length === 1 && typeof c === 'string' && c.startsWith('\u0000')) {
          const k = c.slice(1)
          if (seen.has(k)) continue
          seen.add(k)
          const g = groups.get(k)!
          final.push(this.compileMultiGroup(g.r, g.leaves))
        } else final.push(p)
      }
      parts.length = 0
      parts.push(...final)
    } else {
      for (const child of q.children) {
        if (child instanceof QNode) {
          const s = this.compileQ(child)
          parts.push(s.isEmpty ? Sql.raw('1 = 1') : s)
          continue
        }
        parts.push(this.compileLeaf(child[0], child[1]))
      }
    }
    if (parts.length === 0) return q.negated ? Sql.raw('1 = 0') : new Sql()
    let out =
      parts.length === 1
        ? parts[0]
        : Sql.join(
            parts.map((p) => p.wrap('(', ')')),
            ` ${q.connector} `,
          )
    if (q.negated) {
      out = out.wrap(this.dialect === 'postgresql' ? 'NOT COALESCE((' : 'NOT COALESCE((', '), FALSE)')
    }
    return out
  }

  compileLeaf(key: string, value: unknown): Sql {
    const r = this.resolvePath(key.split(LOOKUP_SEP), { allowMulti: false })
    return this.compileResolvedLeaf(r, key, value)
  }

  private compileResolvedLeaf(r: Resolved, key: string, value: unknown): Sql {
    if (r.kind === 'multi') {
      if (r.rest.length === 1 && r.rest[0] === 'isnull') {
        const sub = new Scope(this.compiler, this)
        const hop = this.buildHop(sub, r)
        const exists = new Sql(['EXISTS (SELECT 1 FROM ']).append(hop.from)
        for (const j of sub.joins) exists.append(' ').append(j)
        exists.append(' WHERE ').append(hop.correlate).append(')')
        return value ? exists.wrap('NOT ', '') : exists
      }
      return this.compileMultiGroup(r, [[key, value]])
    }
    if (r.kind === 'annotation') {
      const lhs = r.expr.compile(this)
      return this.compileLookup(lhs, r.expr.outputField(this), r.rest, value, key)
    }
    const lhs = this.col(r.entry, r.field.column)
    return this.compileLookup(lhs, r.field, r.rest, value, key)
  }

  private compileMultiGroup(r: Extract<Resolved, { kind: 'multi' }>, leaves: Array<[string, unknown]>): Sql {
    const sub = new Scope(this.compiler, this)
    const hop = this.buildHop(sub, r)
    const conds = leaves.map(([k, v]) => sub.compileLeaf(k, v))
    const out = new Sql(['EXISTS (SELECT 1 FROM ']).append(hop.from)
    for (const j of sub.joins) out.append(' ').append(j)
    out
      .append(' WHERE ')
      .append(Sql.join([hop.correlate, ...conds], ' AND '))
      .append(')')
    return out
  }

  // ---- lookups ----------------------------------------------------------------------------------

  private applyTransform(
    name: string,
    lhs: Sql,
    field: Field<any, any> | undefined,
  ): { lhs: Sql; field: Field<any, any> } {
    const isDateTime = field?.internalType === 'DateTimeField'
    const pg = this.dialect === 'postgresql'
    const intField = new IntegerField()
    if (name === 'date') {
      if (!isDateTime) return { lhs, field: new DateField() }
      return {
        lhs: pg ? lhs.wrap('CAST((', " AT TIME ZONE 'UTC') AS date)") : lhs.wrap('substr(', ', 1, 10)'),
        field: new DateField(),
      }
    }
    if (name === 'time') {
      return {
        lhs: pg ? lhs.wrap('CAST((', " AT TIME ZONE 'UTC') AS time)") : lhs.wrap('substr(', ', 12, 8)'),
        field: field!,
      }
    }
    const parts: Record<string, [string, string]> = {
      year: ['%Y', 'YEAR'],
      month: ['%m', 'MONTH'],
      day: ['%d', 'DAY'],
      hour: ['%H', 'HOUR'],
      minute: ['%M', 'MINUTE'],
      second: ['%S', 'SECOND'],
      week_day: ['%w', 'DOW'],
      quarter: ['%m', 'QUARTER'],
    }
    const spec = parts[name]
    if (!spec) throw new FieldError(`Unsupported transform '${name}'.`)
    let out: Sql
    if (pg) {
      const src = isDateTime ? lhs.wrap('(', " AT TIME ZONE 'UTC')") : lhs
      out = src.wrap(`CAST(EXTRACT(${spec[1]} FROM `, ') AS integer)')
      if (name === 'week_day') out = out.wrap('(', ' + 1)')
    } else {
      out = lhs.wrap(`CAST(strftime('${spec[0]}', `, ') AS integer)')
      if (name === 'week_day') out = out.wrap('(', ' + 1)')
      if (name === 'quarter') out = out.wrap('((', ' + 2) / 3)')
    }
    return { lhs: out, field: intField }
  }

  private prepValue(v: unknown, field: Field<any, any> | undefined): Sql {
    if (v instanceof Expression) return v.compile(this)
    if (isQuerySetLike(v)) return compileSubquery(v.state, this.compiler)
    let value = v
    if (isModelInstance(value) && !(field instanceof ForeignKey)) value = value.pk
    return this.compileValue(value, field)
  }

  private rawValue(v: unknown, field: Field<any, any> | undefined): unknown {
    let value = v
    if (isModelInstance(value) && !(field instanceof ForeignKey)) value = value.pk
    if (!field) return value
    return field.toDb(field.getPrepValue(value) as any, this.dialect)
  }

  private textLhs(lhs: Sql, field: Field<any, any> | undefined): Sql {
    if (this.dialect === 'postgresql' && (!field || !TEXT_TYPES.has(field.internalType)))
      return lhs.wrap('CAST(', ' AS text)')
    return lhs
  }

  compileLookup(
    lhsIn: Sql,
    fieldIn: Field<any, any> | undefined,
    rest: string[],
    value: unknown,
    key: string,
  ): Sql {
    let lhs = lhsIn
    let field = fieldIn
    let lookup = 'exact'
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i]
      if (TRANSFORMS.has(p) && !(i === rest.length - 1 && LOOKUPS.has(p))) {
        ;({ lhs, field } = this.applyTransform(p, lhs, field))
        continue
      }
      if (LOOKUPS.has(p) && i === rest.length - 1) {
        lookup = p
        continue
      }
      throw new FieldError(
        `Unsupported lookup '${p}' for ${field?.internalType ?? 'expression'} in '${key}'.`,
      )
    }
    const pg = this.dialect === 'postgresql'
    switch (lookup) {
      case 'exact':
        if (value === null || value === undefined) return lhs.wrap('', ' IS NULL')
        return new Sql().append(lhs).append(' = ').append(this.prepValue(value, field))
      case 'iexact': {
        if (value === null || value === undefined) return lhs.wrap('', ' IS NULL')
        const rhs = this.prepValue(value instanceof Expression ? value : String(value), undefined)
        return new Sql()
          .append(this.textLhs(lhs, field).wrap('UPPER(', ')'))
          .append(' = ')
          .append(rhs.wrap('UPPER(', ')'))
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[lookup]
        return new Sql().append(lhs).append(` ${op} `).append(this.prepValue(value, field))
      }
      case 'in': {
        if (isQuerySetLike(value)) {
          return new Sql()
            .append(lhs)
            .append(' IN (')
            .append(compileSubquery(value.state, this.compiler))
            .append(')')
        }
        const items = [...((value as Iterable<unknown>) ?? [])].filter((v) => v !== null && v !== undefined)
        if (items.length === 0) return Sql.raw('1 = 0')
        const max = this.compiler.features?.maxQueryParams ?? 999
        if (!pg && items.length > Math.min(50, max / 2) && !items.some((v) => v instanceof Expression)) {
          const raw = items.map((v) => this.rawValue(v, field))
          return new Sql()
            .append(lhs)
            .append(' IN (SELECT value FROM json_each(')
            .append(Sql.param(JSON.stringify(raw)))
            .append('))')
        }
        return new Sql()
          .append(lhs)
          .append(' IN (')
          .append(Sql.join(items.map((v) => this.prepValue(v, field))))
          .append(')')
      }
      case 'range': {
        const [a, b] = value as [unknown, unknown]
        return new Sql()
          .append(lhs)
          .append(' BETWEEN ')
          .append(this.prepValue(a, field))
          .append(' AND ')
          .append(this.prepValue(b, field))
      }
      case 'isnull':
        return lhs.wrap('', value ? ' IS NULL' : ' IS NOT NULL')
      case 'contains':
      case 'startswith':
      case 'endswith':
      case 'icontains':
      case 'istartswith':
      case 'iendswith': {
        if (value === null || value === undefined) return Sql.raw('1 = 0')
        const insensitive = lookup.startsWith('i')
        const kind = insensitive ? lookup.slice(1) : lookup
        const textL = this.textLhs(lhs, field)
        if (value instanceof Expression) {
          // pattern from another column/expression: compare with string functions (no wildcards involved)
          let l = textL
          let r = value.compile(this)
          if (
            pg &&
            !(
              value instanceof Expression &&
              value.outputField(this) &&
              TEXT_TYPES.has(value.outputField(this)!.internalType)
            )
          ) {
            r = r.wrap('CAST(', ' AS text)')
          }
          if (insensitive) {
            l = l.wrap('UPPER(', ')')
            r = r.wrap('UPPER(', ')')
          }
          if (kind === 'contains') {
            return new Sql([pg ? 'strpos(' : 'instr(']).append(l).append(', ').append(r).append(') > 0')
          }
          const len = r.wrap('length(', ')')
          const part =
            kind === 'startswith'
              ? pg
                ? new Sql(['left(']).append(l).append(', ').append(len).append(')')
                : new Sql(['substr(']).append(l).append(', 1, ').append(len).append(')')
              : pg
                ? new Sql(['right(']).append(l).append(', ').append(len).append(')')
                : new Sql(['substr(']).append(l).append(', -').append(len).append(')')
          return part.append(' = ').append(r)
        }
        const s = String(value)
        if (!insensitive && !pg) {
          const g = globEscape(s)
          const pattern = kind === 'contains' ? `*${g}*` : kind === 'startswith' ? `${g}*` : `*${g}`
          return new Sql().append(lhs).append(' GLOB ').append(Sql.param(pattern))
        }
        const e = likeEscape(s)
        const pattern = kind === 'contains' ? `%${e}%` : kind === 'startswith' ? `${e}%` : `%${e}`
        const op = insensitive && pg ? ' ILIKE ' : ' LIKE '
        return new Sql().append(textL).append(op).append(Sql.param(pattern)).append(" ESCAPE '\\'")
      }
      case 'regex':
      case 'iregex': {
        if (this.compiler.features && !this.compiler.features.supportsRegex) {
          throw new NotSupportedError(`The '${lookup}' lookup is not supported on this database backend.`)
        }
        const pattern = String(value)
        if (pg)
          return new Sql()
            .append(this.textLhs(lhs, field))
            .append(lookup === 'regex' ? ' ~ ' : ' ~* ')
            .append(Sql.param(pattern))
        return new Sql()
          .append(lhs)
          .append(' REGEXP ')
          .append(Sql.param(lookup === 'iregex' ? `(?i)${pattern}` : pattern))
      }
    }
    throw new FieldError(`Unsupported lookup '${lookup}'.`)
  }
}

// ---- SELECT -------------------------------------------------------------------------------------

export interface ModelPlan {
  kind: 'model'
  model: ModelClass
  fields: Array<{ field: Field<any, any>; alias: string }>
  deferred: string[]
  related: Array<{ name: string; reverse: boolean; plan: ModelPlan; pkAlias: string }>
  annotations: Array<{ name: string; alias: string; expr: Expression }>
}

export interface ValuesPlan {
  kind: 'values'
  mode: ValuesSpec['kind']
  columns: Array<{ key: string; alias: string; convert: (v: unknown) => unknown }>
}

export interface CompiledSelect {
  sql: Sql
  plan: ModelPlan | ValuesPlan
  scope: Scope
}

function resolveLoadedFields(state: QueryState): { load: Field<any, any>[]; deferred: string[] } {
  const meta = state.model._meta
  const all = meta.concreteFields
  if (!state.loadFields) return { load: all, deferred: [] }
  const names = new Set(
    state.loadFields.names.map((n) => {
      const f = meta.getForwardField(n)
      if (!f) throw new FieldError(`${meta.objectName} has no field named '${n}'`)
      return f.name
    }),
  )
  const load =
    state.loadFields.mode === 'only'
      ? all.filter((f) => f.primaryKey || names.has(f.name))
      : all.filter((f) => f.primaryKey || !names.has(f.name))
  const loaded = new Set(load.map((f) => f.name))
  return { load, deferred: all.filter((f) => !loaded.has(f.name)).map((f) => f.attname) }
}

function orderingFor(state: QueryState, grouping: boolean): Array<string | OrderBy> {
  let ordering = state.ordering ?? (grouping ? [] : state.model._meta.ordering)
  if (state.reversed) {
    if (!ordering.length) ordering = [state.model._meta.pk.name]
    ordering = ordering.map((o) =>
      o instanceof OrderBy ? o.reversed() : o.startsWith('-') ? o.slice(1) : o === '?' ? o : `-${o}`,
    )
  }
  return ordering
}

export interface SelectOptions {
  /** Ignore ordering (count / exists / subqueries). */
  noOrdering?: boolean
  /** Ignore slicing. */
  noLimit?: boolean
  /** Select only this single column (subquery for `__in`). */
  singleColumn?: string
}

/** Compile a SELECT for a QueryState. */
export function compileSelect(
  state: QueryState,
  compiler: Compiler,
  opts: SelectOptions = {},
): CompiledSelect {
  const model = state.model
  const meta = model._meta
  const scope = Scope.root(compiler, model)
  const root = scope.rootEntry
  for (const [name, expr] of state.annotations) scope.annotations.set(name, expr)
  const grouping = state.groupBy !== null && state.annotations.some(([, e]) => e.containsAggregate)
  if (grouping) scope.aggregateJoins = true

  // WHERE / HAVING
  const where: Sql[] = []
  const having: Sql[] = []
  for (const q of state.where) {
    const s = scope.compileQ(q)
    if (s.isEmpty) continue
    ;(s.containsAggregate ? having : where).push(s)
  }

  const select: Sql[] = []
  let plan: ModelPlan | ValuesPlan
  const groupByExprs: Sql[] = []
  let selectHasAggregate = false
  let aliasN = 0
  const nextColAlias = (p: string) => `${p}${aliasN++}`

  if (opts.singleColumn) {
    const r = scope.resolvePath(opts.singleColumn.split(LOOKUP_SEP), { allowMulti: true })
    let s: Sql
    if (r.kind === 'annotation') s = r.expr.compile(scope)
    else if (r.kind === 'column') s = scope.col(r.entry, r.field.column)
    else throw new FieldError(`Cannot select '${opts.singleColumn}'.`)
    select.push(s)
    plan = { kind: 'values', mode: 'flat', columns: [] }
    if (grouping) {
      // values('x').annotate(...) used as subquery
      for (const f of state.groupBy ?? []) {
        const rr = scope.resolvePath(f.split(LOOKUP_SEP), { allowMulti: true })
        if (rr.kind === 'column') groupByExprs.push(scope.col(rr.entry, rr.field.column))
      }
    }
  } else if (state.values) {
    const spec = state.values
    const columns: ValuesPlan['columns'] = []
    const names = spec.fields.length
      ? spec.fields
      : [...meta.concreteFields.map((f) => f.attname), ...state.annotations.map(([n]) => n)]
    const annotationNames = new Set(state.annotations.map(([n]) => n))
    const listed = new Set(names)
    const extraAnnotations = spec.fields.length
      ? state.annotations
          .slice(spec.annotationStart)
          .map(([n]) => n)
          .filter((n) => !listed.has(n))
      : []
    for (const name of [...names, ...extraAnnotations]) {
      const alias = nextColAlias('v')
      if (annotationNames.has(name) && !meta.findField(name)) {
        const expr = scope.findAnnotation(name)!
        const s = expr.compile(scope)
        if (s.containsAggregate) selectHasAggregate = true
        select.push(new Sql().append(s).append(` AS ${ident(alias).chunks[0]}`))
        columns.push({ key: name, alias, convert: (v) => expr.convertValue(v, scope) })
        continue
      }
      const r = scope.resolvePath(name.split(LOOKUP_SEP), { allowMulti: true })
      if (r.kind === 'annotation') {
        const s = r.expr.compile(scope)
        select.push(new Sql().append(s).append(` AS ${ident(alias).chunks[0]}`))
        columns.push({ key: name, alias, convert: (v) => r.expr.convertValue(v, scope) })
        continue
      }
      if (r.kind !== 'column') throw new FieldError(`Cannot select '${name}'.`)
      if (r.rest.length) {
        // transforms in values (e.g. 'createdAt__year')
        const lhs = scope.col(r.entry, r.field.column)
        let out = lhs
        let f: Field<any, any> = r.field
        for (const t of r.rest) {
          if (!TRANSFORMS.has(t)) throw new FieldError(`Cannot resolve keyword '${t}' in values('${name}').`)
          ;({ lhs: out, field: f } = (scope as any).applyTransform(t, out, f))
        }
        select.push(new Sql().append(out).append(` AS ${ident(alias).chunks[0]}`))
        groupByExprs.push(out)
        const ff = f
        columns.push({
          key: name,
          alias,
          convert: (v) => (v === null || v === undefined ? null : ff.fromDb(v, compiler.dialect)),
        })
        continue
      }
      const colSql = scope.col(r.entry, r.field.column)
      select.push(new Sql().append(colSql).append(` AS ${ident(alias).chunks[0]}`))
      groupByExprs.push(colSql)
      const field = r.field
      columns.push({
        key: name,
        alias,
        convert: (v) => (v === null || v === undefined ? null : field.fromDb(v, compiler.dialect)),
      })
    }
    plan = { kind: 'values', mode: spec.kind, columns }
    if (grouping && state.groupBy) {
      // GROUP BY the values() fields that were active when aggregating
      groupByExprs.length = 0
      for (const f of state.groupBy.length ? state.groupBy : meta.concreteFields.map((x) => x.attname)) {
        if (annotationNames.has(f)) continue
        const rr = scope.resolvePath(f.split(LOOKUP_SEP), { allowMulti: true })
        if (rr.kind === 'column') groupByExprs.push(scope.col(rr.entry, rr.field.column))
      }
    }
  } else {
    // model instances
    const { load, deferred } = resolveLoadedFields(state)
    const fields = load.map((field) => {
      const alias = nextColAlias('c')
      const colSql = scope.col(root, field.column)
      select.push(new Sql().append(colSql).append(` AS ${ident(alias).chunks[0]}`))
      groupByExprs.push(colSql)
      return { field, alias }
    })
    const modelPlan: ModelPlan = { kind: 'model', model, fields, deferred, related: [], annotations: [] }
    // select_related
    const paths =
      state.selectRelated === true
        ? meta.concreteFields.filter((f) => f instanceof ForeignKey && !f.null).map((f) => f.name)
        : (state.selectRelated ?? [])
    for (const path of paths) {
      let parentPlan = modelPlan
      let entry = root
      let key = ''
      for (const part of path.split(LOOKUP_SEP)) {
        const pmeta = entry.model._meta
        const f = pmeta.findField(part)
        const newKey = key ? `${key}${LOOKUP_SEP}${part}` : part
        let reverse = false
        let target: ModelClass
        if (f instanceof ForeignKey && part === f.name) {
          target = f.relatedModel
          entry = (scope as any).joinForward(entry, newKey, f)
        } else if (f instanceof RelatedObject && f.oneToOne) {
          reverse = true
          target = f.relatedModel
          entry = (scope as any).joinReverse(entry, newKey, f)
        } else {
          throw new FieldError(
            `Invalid field name given in selectRelated: '${part}'. Choices are: ${pmeta.concreteFields
              .filter((x) => x instanceof ForeignKey)
              .map((x) => x.name)
              .join(', ')}`,
          )
        }
        key = newKey
        const name = reverse ? (f as RelatedObject).getAccessorName()! : part
        let existing = parentPlan.related.find((r) => r.name === name)
        if (!existing) {
          const relFields = target._meta.concreteFields.map((field) => {
            const alias = nextColAlias('c')
            const colSql = scope.col(entry, field.column)
            select.push(new Sql().append(colSql).append(` AS ${ident(alias).chunks[0]}`))
            groupByExprs.push(colSql)
            return { field, alias }
          })
          const pkAlias = relFields.find((x) => x.field.primaryKey)!.alias
          existing = {
            name,
            reverse,
            pkAlias,
            plan: {
              kind: 'model',
              model: target,
              fields: relFields,
              deferred: [],
              related: [],
              annotations: [],
            },
          }
          parentPlan.related.push(existing)
        }
        parentPlan = existing.plan
      }
    }
    for (const [name, expr] of state.annotations) {
      const alias = nextColAlias('a')
      const s = expr.compile(scope)
      if (s.containsAggregate) selectHasAggregate = true
      select.push(new Sql().append(s).append(` AS ${ident(alias).chunks[0]}`))
      modelPlan.annotations.push({ name, alias, expr })
    }
    plan = modelPlan
  }

  // ORDER BY
  const orderParts: Sql[] = []
  if (!opts.noOrdering) {
    for (const o of orderingFor(state, grouping)) {
      orderParts.push(compileOrderItem(scope, o, plan))
    }
  }

  const out = new Sql([state.distinct ? 'SELECT DISTINCT ' : 'SELECT '])
  out.append(Sql.join(select))
  out.append(' FROM ').append(ident(meta.dbTable)).append(' AS ').append(ident(root.alias!))
  for (const j of scope.joins) out.append(' ').append(j)
  if (where.length)
    out.append(' WHERE ').append(
      Sql.join(
        where.map((w) => (where.length > 1 ? w.wrap('(', ')') : w)),
        ' AND ',
      ),
    )
  const needsGroup = grouping || (selectHasAggregate && groupByExprs.length > 0) || having.length > 0
  if (needsGroup && groupByExprs.length) out.append(' GROUP BY ').append(Sql.join(groupByExprs))
  if (having.length) out.append(' HAVING ').append(Sql.join(having, ' AND '))
  if (orderParts.length) out.append(' ORDER BY ').append(Sql.join(orderParts))
  if (!opts.noLimit) appendLimit(out, state, compiler.dialect)
  out.containsAggregate = false
  return { sql: out, plan, scope }
}

export function appendLimit(out: Sql, state: QueryState, dialect: Dialect): void {
  if (state.high !== null) {
    out.append(` LIMIT ${Math.max(0, state.high - state.low)}`)
    if (state.low) out.append(` OFFSET ${state.low}`)
  } else if (state.low) {
    out.append(dialect === 'sqlite' ? ` LIMIT -1 OFFSET ${state.low}` : ` OFFSET ${state.low}`)
  }
}

/**
 * NULL ordering is normalized to SQLite's (NULLs are the smallest values) so results don't change when
 * moving from D1/SQLite to PostgreSQL. PostgreSQL gets explicit NULLS FIRST/LAST for nullable columns.
 */
function pgNulls(scope: Scope, desc: boolean, nullable: boolean): string {
  if (scope.dialect !== 'postgresql' || !nullable) return ''
  return desc ? ' NULLS LAST' : ' NULLS FIRST'
}

function compileOrderItem(scope: Scope, o: string | OrderBy, plan: ModelPlan | ValuesPlan): Sql {
  if (o instanceof OrderBy) {
    let s = o.expression.compile(scope).wrap('', o.descending ? ' DESC' : ' ASC')
    if (o.opts.nullsFirst) s = s.wrap('', ' NULLS FIRST')
    else if (o.opts.nullsLast) s = s.wrap('', ' NULLS LAST')
    else s = s.wrap('', pgNulls(scope, o.descending, true))
    return s
  }
  if (o === '?') return Sql.raw('RANDOM()')
  const desc = o.startsWith('-')
  const name = desc ? o.slice(1) : o.replace(/^\+/, '')
  const dir = desc ? ' DESC' : ' ASC'
  // Order by an annotation / values column through its select alias.
  if (plan.kind === 'model') {
    const a = plan.annotations.find((x) => x.name === name)
    if (a) return ident(a.alias).wrap('', dir + pgNulls(scope, desc, true))
  } else {
    const c = plan.columns.find((x) => x.key === name)
    if (c && scope.findAnnotation(name)) return ident(c.alias).wrap('', dir + pgNulls(scope, desc, true))
  }
  const r = scope.resolvePath(name.split(LOOKUP_SEP), { allowMulti: true })
  if (r.kind === 'annotation') return r.expr.compile(scope).wrap('', dir + pgNulls(scope, desc, true))
  if (r.kind !== 'column' || r.rest.length)
    throw new FieldError(`Cannot resolve keyword '${name}' into field for ordering.`)
  const nullable = r.field.null || r.entry !== scope.rootEntry
  return scope.col(r.entry, r.field.column).wrap('', dir + pgNulls(scope, desc, nullable))
}

/** SELECT used as a value subquery (`pk__in: qs`, `exact: qs`). */
export function compileSubquery(state: QueryState, compiler: Compiler): Sql {
  let column = state.model._meta.pk.name
  if (state.values) {
    const fields = state.values.fields
    if (fields.length !== 1)
      throw new FieldError(
        'A subquery used as a value must select exactly one field (valuesList("x", { flat: true })).',
      )
    column = fields[0]
  }
  const sliced = isSliced(state)
  return compileSelect(state, compiler, { singleColumn: column, noOrdering: !sliced, noLimit: !sliced }).sql
}

/** `SELECT COUNT(*)`, wrapping the query when it is sliced, distinct or grouped. */
export function compileCount(state: QueryState, compiler: Compiler): Sql {
  const grouping = state.groupBy !== null && state.annotations.some(([, e]) => e.containsAggregate)
  const hasAggregateFilter = false
  if (state.distinct || isSliced(state) || grouping || hasAggregateFilter || state.values) {
    const inner = compileSelect(state, compiler, { noOrdering: !isSliced(state) }).sql
    return new Sql(['SELECT COUNT(*) AS "n" FROM (']).append(inner).append(') AS "count_sub"')
  }
  const scope = Scope.root(compiler, state.model)
  for (const [name, expr] of state.annotations) scope.annotations.set(name, expr)
  const where: Sql[] = []
  const having: Sql[] = []
  for (const q of state.where) {
    const s = scope.compileQ(q)
    if (!s.isEmpty) (s.containsAggregate ? having : where).push(s)
  }
  if (having.length) {
    const inner = compileSelect(state, compiler, { noOrdering: true }).sql
    return new Sql(['SELECT COUNT(*) AS "n" FROM (']).append(inner).append(') AS "count_sub"')
  }
  const out = new Sql(['SELECT COUNT(*) AS "n" FROM '])
  out.append(ident(state.model._meta.dbTable)).append(' AS ').append(ident(scope.rootEntry.alias!))
  for (const j of scope.joins) out.append(' ').append(j)
  if (where.length)
    out.append(' WHERE ').append(
      Sql.join(
        where.map((w) => w.wrap('(', ')')),
        ' AND ',
      ),
    )
  return out
}

/** `WHERE pk IN (SELECT pk FROM ... )` helper used by UPDATE/DELETE. Returns null when unfiltered. */
export function compilePkSubquery(state: QueryState, compiler: Compiler): Sql | null {
  if (!state.where.length && !isSliced(state)) return null
  const sub: QueryState = { ...state, values: null, annotations: state.annotations, selectRelated: null }
  return compileSelect(sub, compiler, {
    singleColumn: state.model._meta.pk.name,
    noOrdering: !isSliced(state),
    noLimit: !isSliced(state),
  }).sql
}

/** Compile `UPDATE ... SET ...` for `qs.update(values)`. */
export function compileUpdate(state: QueryState, compiler: Compiler, values: Record<string, unknown>): Sql {
  const meta = state.model._meta
  const setScope = Scope.root(compiler, state.model, null)
  setScope.noJoins = true
  const assignments: Sql[] = []
  for (const [name, value] of Object.entries(values)) {
    const field = meta.getForwardField(name)
    if (!field) throw new FieldError(`${meta.objectName} has no field named '${name}'`)
    if (!field.concrete)
      throw new FieldError(
        `Cannot update model field '${name}' (only non-relations and foreign keys permitted).`,
      )
    let rhs: Sql
    if (value instanceof Expression) rhs = value.compile(setScope)
    else {
      const v = isModelInstance(value) && !(field instanceof ForeignKey) ? (value as BaseModel).pk : value
      rhs =
        v === null || v === undefined
          ? Sql.raw('NULL')
          : field.dbParam(field.getPrepValue(v), compiler.dialect)
    }
    assignments.push(new Sql().append(ident(field.column)).append(' = ').append(rhs))
  }
  const out = new Sql(['UPDATE ']).append(ident(meta.dbTable)).append(' SET ').append(Sql.join(assignments))
  const pks = compilePkSubquery(state, compiler)
  if (pks) out.append(' WHERE ').append(ident(meta.pk.column)).append(' IN (').append(pks).append(')')
  return out
}

/** Map a raw row to a model instance according to a ModelPlan. */
export function readModelRow(
  plan: ModelPlan,
  row: Record<string, unknown>,
  scope: Scope,
  using: string | undefined,
): BaseModel {
  const values: Record<string, unknown> = {}
  for (const { field, alias } of plan.fields) values[field.attname] = field.fromDb(row[alias], scope.dialect)
  const obj = (plan.model as any)._fromDb(values, plan.deferred, using) as BaseModel
  for (const rel of plan.related) {
    const pk = row[rel.pkAlias]
    const state = (obj as any)._state
    if (pk === null || pk === undefined) {
      state.fieldsCache.set(rel.name, null)
      continue
    }
    const child = readModelRow(rel.plan, row, scope, using)
    state.fieldsCache.set(rel.name, child)
  }
  for (const a of plan.annotations) {
    ;(obj as any)[a.name] = a.expr.convertValue(row[a.alias], scope)
    ;(obj as any)._state.annotations.add(a.name)
  }
  return obj
}

export function readValuesRow(plan: ValuesPlan, row: Record<string, unknown>): unknown {
  const cols = plan.columns
  if (plan.mode === 'flat') return cols[0].convert(row[cols[0].alias])
  if (plan.mode === 'list') return cols.map((c) => c.convert(row[c.alias]))
  const out: Record<string, unknown> = {}
  for (const c of cols) out[c.key] = c.convert(row[c.alias])
  return out
}
