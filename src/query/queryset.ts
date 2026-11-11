import { atomic, connections, DEFAULT_DB_ALIAS } from '../db/connections'
import type { Connection } from '../db/types'
import { FieldError, IntegrityError } from '../errors'
import { Collector } from '../models/deletion'
import type { BaseModel, ModelClass } from '../models/types'
import { chunk, LOOKUP_SEP } from '../utils'
import {
  Compiler,
  compileCount,
  compileSelect,
  compileUpdate,
  emptyState,
  isSliced,
  type ModelPlan,
  type QueryState,
  readModelRow,
  readValuesRow,
  Scope,
} from './compiler'
import { Aggregate, Expression, type OrderBy, Q, type QNode } from './expressions'
import { Prefetch, prefetchRelatedObjects } from './prefetch'
import { ident, Sql } from './sql'

/** Filter keyword object: direct field names autocomplete; any `__` lookup string is accepted. */
export type FilterArg<T> = QNode | ({ [K in keyof T & string]?: unknown } & Record<string, unknown>)
type CreateValue<V> = [Extract<V, PromiseLike<any>>] extends [never]
  ? V
  : Exclude<V, PromiseLike<any>> | BaseModel
/** Data accepted by `create()` / constructors (field names, `${fk}Id`, related instances). */
export type CreateData<T> = { [K in keyof T]?: CreateValue<T[K]> | null } & Record<string, unknown>
export type AggregateSpec = Record<string, Aggregate | Expression>
export interface ValuesListOptions {
  flat?: boolean
  named?: boolean
}
export interface BulkCreateOptions {
  batchSize?: number
  /** `ON CONFLICT DO NOTHING` (primary keys of inserted rows are not set). */
  ignoreConflicts?: boolean
}

const MAX_GET_RESULTS = 21

function _isModelInstance(v: unknown): v is BaseModel {
  return (
    !!v &&
    typeof v === 'object' &&
    '_state' in (v as object) &&
    typeof (v as any).constructor?._meta === 'object'
  )
}

/**
 * Lazy, immutable, chainable query. Awaiting it (it's thenable) or iterating it with `for await`
 * runs the query; results are cached on the instance like Django.
 *
 * Note: because QuerySets are thenable, returning one from an `async` function resolves it to an array.
 */
export class QuerySet<T = any> implements PromiseLike<T[]>, AsyncIterable<T> {
  readonly _isQuerySet = true as const
  readonly state: QueryState
  protected _resultCache: T[] | null = null

  constructor(model: ModelClass, state?: QueryState) {
    this.state = state ?? emptyState(model)
  }

  get model(): ModelClass {
    return this.state.model
  }

  /** Database alias used by this query. */
  get db(): string {
    return this.state.using ?? DEFAULT_DB_ALIAS
  }

  /** True if the query has an explicit or default ordering. */
  get ordered(): boolean {
    if (this.state.ordering) return this.state.ordering.length > 0
    return this.model._meta.ordering.length > 0
  }

  protected chain<R = T>(patch: Partial<QueryState>): QuerySet<R> {
    const Ctor = this.constructor as new (model: ModelClass, state: QueryState) => QuerySet<R>
    return new Ctor(this.state.model, { ...this.state, ...patch })
  }

  /** @internal Prefill the result cache (prefetched related managers). */
  _withResults(results: T[]): this {
    this._resultCache = results
    return this
  }

  private assertNotSliced(op: string): void {
    if (isSliced(this.state)) throw new TypeError(`Cannot ${op} a query once a slice has been taken.`)
  }

  // ---- chaining ---------------------------------------------------------------------------------

  all(): QuerySet<T> {
    return this.chain({})
  }

  filter(...args: FilterArg<T>[]): QuerySet<T> {
    if (!args.length) return this.chain({})
    this.assertNotSliced('filter')
    const q = Q(...(args as Array<QNode | Record<string, unknown>>))
    return this.chain({ where: [...this.state.where, q] })
  }

  exclude(...args: FilterArg<T>[]): QuerySet<T> {
    if (!args.length) return this.chain({})
    this.assertNotSliced('filter')
    const q = Q(...(args as Array<QNode | Record<string, unknown>>)).not()
    return this.chain({ where: [...this.state.where, q] })
  }

  /** `orderBy('-createdAt', 'title')`, `orderBy(F('x').desc({ nullsLast: true }))`; no args clears ordering. */
  orderBy(...fields: Array<string | OrderBy | Expression>): QuerySet<T> {
    this.assertNotSliced('reorder')
    const ordering = fields.map((f) => (f instanceof Expression ? f.asc() : f))
    return this.chain({ ordering, reversed: false })
  }

  reverse(): QuerySet<T> {
    return this.chain({ reversed: !this.state.reversed })
  }

  distinct(...fields: string[]): QuerySet<T> {
    if (fields.length)
      throw new FieldError('distinct(*fields) (DISTINCT ON) is not supported; use distinct().')
    return this.chain({ distinct: true })
  }

  /** Python-style slicing: `slice(0, 10)` → LIMIT 10, `slice(5)` → OFFSET 5. */
  slice(start: number, end?: number): QuerySet<T> {
    if (start < 0 || (end !== undefined && end < 0))
      throw new TypeError('Negative indexing is not supported.')
    const { low, high } = this.state
    const newLow = low + start
    let newHigh = end === undefined ? high : low + end
    if (high !== null && newHigh !== null) newHigh = Math.min(newHigh, high)
    if (newHigh !== null && newHigh < newLow) newHigh = newLow
    return this.chain({ low: newLow, high: newHigh })
  }

  /** LIMIT shortcut: `limit(10)` ≡ `slice(0, 10)`. */
  limit(n: number): QuerySet<T> {
    return this.slice(0, n)
  }

  only(...fields: string[]): QuerySet<T> {
    return this.chain({ loadFields: { names: fields, mode: 'only' } })
  }

  defer(...fields: Array<string | null>): QuerySet<T> {
    if (fields.length === 1 && fields[0] === null) return this.chain({ loadFields: null })
    const prev = this.state.loadFields?.mode === 'defer' ? this.state.loadFields.names : []
    return this.chain({ loadFields: { names: [...prev, ...(fields as string[])], mode: 'defer' } })
  }

  none(): QuerySet<T> {
    return this.chain({ isNone: true })
  }

  using(alias: string): QuerySet<T> {
    return this.chain({ using: alias })
  }

  /** Join and load FK / one-to-one related objects in the same query (`selectRelated('author')`). */
  selectRelated(...paths: Array<string | null>): QuerySet<T> {
    if (paths.length === 1 && paths[0] === null) return this.chain({ selectRelated: null })
    if (!paths.length) return this.chain({ selectRelated: true })
    const prev = Array.isArray(this.state.selectRelated) ? this.state.selectRelated : []
    return this.chain({ selectRelated: [...new Set([...prev, ...(paths as string[])])] })
  }

  /** Load reverse FK / M2M (or FK) relations with one extra query per lookup. */
  prefetchRelated(...lookups: Array<string | Prefetch | null>): QuerySet<T> {
    if (lookups.length === 1 && lookups[0] === null) return this.chain({ prefetch: [] })
    return this.chain({ prefetch: [...this.state.prefetch, ...(lookups as Array<string | Prefetch>)] })
  }

  annotate(spec: Record<string, Expression>): QuerySet<T> {
    const meta = this.model._meta
    const annotations = [...this.state.annotations]
    let groupBy = this.state.groupBy
    for (const [name, expr] of Object.entries(spec)) {
      if (!(expr instanceof Expression))
        throw new TypeError(`annotate(): '${name}' must be an expression (F, Count, Value, …).`)
      if (meta.getForwardField(name))
        throw new FieldError(`The annotation '${name}' conflicts with a field on the model.`)
      if (annotations.some(([n]) => n === name))
        throw new FieldError(`The annotation '${name}' is already defined.`)
      annotations.push([name, expr])
      if (this.state.values && expr.containsAggregate && groupBy === null)
        groupBy = [...this.state.values.fields]
    }
    return this.chain({ annotations, groupBy })
  }

  /** Dict rows: `values('id', 'author__username')`. */
  values(...fields: string[]): QuerySet<Record<string, any>> {
    return this.chain<Record<string, any>>({
      values: { kind: 'dict', fields, annotationStart: this.state.annotations.length },
    })
  }

  /** Tuple rows: `valuesList('id', 'title')`, or flat values: `valuesList('id', { flat: true })`. */
  valuesList(...args: Array<string | ValuesListOptions>): QuerySet<any> {
    const last = args[args.length - 1]
    const opts: ValuesListOptions =
      typeof last === 'object' && last !== null ? (args.pop() as ValuesListOptions) : {}
    const fields = args as string[]
    if (opts.flat && opts.named) throw new TypeError("'flat' and 'named' can't be used together.")
    if (opts.flat && fields.length > 1)
      throw new TypeError("'flat' is not valid when valuesList is called with more than one field.")
    const kind = opts.flat ? 'flat' : opts.named ? 'named' : 'list'
    let names = fields
    if (kind === 'flat' && !names.length) names = [this.model._meta.pk.name]
    return this.chain({ values: { kind, fields: names, annotationStart: this.state.annotations.length } })
  }

  // ---- execution --------------------------------------------------------------------------------

  protected async connection(): Promise<Connection> {
    return connections.get(this.db)
  }

  /** Run the query (cached). */
  async fetch(): Promise<T[]> {
    if (this._resultCache) return this._resultCache
    if (this.state.isNone) {
      this._resultCache = []
      return this._resultCache
    }
    const conn = await this.connection()
    const compiler = new Compiler(conn.dialect, conn.features)
    const { sql, plan, scope } = compileSelect(this.state, compiler)
    const { sql: text, params } = sql.render(conn.dialect)
    const { rows } = await conn.execute(text, params)
    let results: T[]
    if (plan.kind === 'model') {
      results = rows.map((r) => readModelRow(plan, r, scope, this.state.using) as T)
      if (this.state.prefetch.length && results.length) {
        await prefetchRelatedObjects(
          results as unknown as BaseModel[],
          this.state.prefetch as Array<string | Prefetch>,
        )
      }
    } else {
      results = rows.map((r) => readValuesRow(plan, r) as T)
    }
    this._resultCache = results
    return results
  }

  /** Alias of `fetch()`. */
  toArray(): Promise<T[]> {
    return this.fetch()
  }

  // biome-ignore lint/suspicious/noThenProperty: QuerySets are intentionally thenable (await qs)
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.fetch().then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<T[] | R> {
    return this.fetch().catch(onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (const r of await this.fetch()) yield r
  }

  /** Iterate in chunks without caching (`chunkSize` rows per query; requires ordering for stability). */
  async *iterator(chunkSize = 2000): AsyncGenerator<T> {
    if (isSliced(this.state)) {
      for (const r of await this.all().fetch()) yield r
      return
    }
    const base = this.ordered ? this : this.orderBy(this.model._meta.pk.name)
    let offset = 0
    while (true) {
      const page = await base.slice(offset, offset + chunkSize).fetch()
      for (const r of page) yield r
      if (page.length < chunkSize) break
      offset += chunkSize
    }
  }

  /** Single object; throws `Model.DoesNotExist` / `Model.MultipleObjectsReturned`. */
  async get(...args: FilterArg<T>[]): Promise<T> {
    let qs: QuerySet<T> = args.length ? this.filter(...args) : this.all()
    if (!isSliced(qs.state)) qs = qs.chain({ ordering: [], reversed: false, high: MAX_GET_RESULTS })
    const rows = await qs.fetch()
    const meta = this.model._meta
    if (rows.length === 1) return rows[0]
    if (rows.length === 0)
      throw new this.model.DoesNotExist(`${meta.objectName} matching query does not exist.`)
    const n = rows.length >= MAX_GET_RESULTS ? `more than ${MAX_GET_RESULTS - 1}` : String(rows.length)
    throw new this.model.MultipleObjectsReturned(
      `get() returned more than one ${meta.objectName} -- it returned ${n}!`,
    )
  }

  private defaultOrdered(): QuerySet<T> {
    return this.ordered ? this : this.orderBy(this.model._meta.pk.name)
  }

  async first(): Promise<T | null> {
    if (this._resultCache) return this._resultCache[0] ?? null
    const rows = await this.defaultOrdered().slice(0, 1).fetch()
    return rows[0] ?? null
  }

  async last(): Promise<T | null> {
    if (this._resultCache) return this._resultCache[this._resultCache.length - 1] ?? null
    const rows = await this.defaultOrdered().reverse().slice(0, 1).fetch()
    return rows[0] ?? null
  }

  private latestFields(fields: string[]): string[] {
    const f = fields.length ? fields : this.model._meta.getLatestBy
    if (!f?.length)
      throw new TypeError(
        "earliest() and latest() require either fields as positional arguments or 'getLatestBy' in the model's Meta.",
      )
    return f
  }

  async latest(...fields: string[]): Promise<T> {
    const order = this.latestFields(fields).map((f) => (f.startsWith('-') ? f.slice(1) : `-${f}`))
    return this.orderBy(...order)
      .slice(0, 1)
      .get()
  }

  async earliest(...fields: string[]): Promise<T> {
    return this.orderBy(...this.latestFields(fields))
      .slice(0, 1)
      .get()
  }

  async count(): Promise<number> {
    if (this._resultCache) return this._resultCache.length
    if (this.state.isNone) return 0
    const conn = await this.connection()
    const compiler = new Compiler(conn.dialect, conn.features)
    const { sql, params } = compileCount(this.state, compiler).render(conn.dialect)
    const { rows } = await conn.execute(sql, params)
    return Number(rows[0]?.n ?? 0)
  }

  async exists(): Promise<boolean> {
    if (this._resultCache) return this._resultCache.length > 0
    if (this.state.isNone) return false
    const conn = await this.connection()
    const compiler = new Compiler(conn.dialect, conn.features)
    const state: QueryState = { ...this.state, values: null, selectRelated: null, prefetch: [] }
    const inner = compileSelect({ ...state, high: isSliced(state) ? state.high : 1 }, compiler, {
      singleColumn: this.model._meta.pk.name,
      noOrdering: true,
    }).sql
    const { sql, params } = inner.render(conn.dialect)
    const { rows } = await conn.execute(sql, params)
    return rows.length > 0
  }

  async contains(obj: T): Promise<boolean> {
    return this.filter({ pk: (obj as unknown as BaseModel).pk } as any).exists()
  }

  /** `aggregate({ total: Count('id'), avg: Avg('views') })` → `{ total, avg }`. */
  async aggregate<S extends AggregateSpec>(spec: S): Promise<{ [K in keyof S]: any }> {
    const entries = Object.entries(spec)
    for (const [name, e] of entries) {
      if (!(e instanceof Expression) || !e.containsAggregate)
        throw new TypeError(`aggregate(): '${name}' is not an aggregate expression.`)
    }
    const out: Record<string, unknown> = {}
    if (this.state.isNone) {
      for (const [name, e] of entries) out[name] = e instanceof Aggregate && e.fn === 'COUNT' ? 0 : null
      return out as any
    }
    const conn = await this.connection()
    const compiler = new Compiler(conn.dialect, conn.features)
    const state = this.state
    const grouping = state.groupBy !== null && state.annotations.some(([, e]) => e.containsAggregate)
    const refsAggregateAnnotation = entries.some(
      ([, e]) =>
        e instanceof Aggregate &&
        typeof e.source === 'string' &&
        state.annotations.some(([n, a]) => n === e.source && a.containsAggregate),
    )
    const wrap =
      state.distinct || isSliced(state) || grouping || refsAggregateAnnotation || state.values !== null
    let query: Sql
    let scope: Scope
    if (!wrap) {
      scope = Scope.root(compiler, this.model)
      scope.aggregateJoins = true
      for (const [n, a] of state.annotations) scope.annotations.set(n, a)
      const where: Sql[] = []
      for (const q of state.where) {
        const s = scope.compileQ(q)
        if (!s.isEmpty) where.push(s)
      }
      const cols = entries.map(([, e], i) => new Sql().append(e.compile(scope)).append(` AS "x${i}"`))
      query = new Sql(['SELECT '])
        .append(Sql.join(cols))
        .append(' FROM ')
        .append(ident(this.model._meta.dbTable))
      query.append(' AS ').append(ident(scope.rootEntry.alias!))
      for (const j of scope.joins) query.append(' ').append(j)
      if (where.length)
        query.append(' WHERE ').append(
          Sql.join(
            where.map((w) => w.wrap('(', ')')),
            ' AND ',
          ),
        )
    } else {
      // Aggregate over a subquery of this queryset's rows.
      const innerState: QueryState = { ...state, values: null, prefetch: [], selectRelated: null }
      const inner = compileSelect(innerState, compiler, { noOrdering: !isSliced(state) })
      const plan = inner.plan as ModelPlan
      scope = inner.scope
      const cols = entries.map(([, e], i) => {
        if (!(e instanceof Aggregate) || typeof e.source !== 'string') {
          throw new FieldError(
            'Only simple aggregates (Count/Sum/Avg/Min/Max of a field or annotation) are supported here.',
          )
        }
        let ref = '*'
        if (e.source !== '*') {
          const src = e.source as string
          const ann = plan.annotations.find((a) => a.name === src)
          const fld = plan.fields.find(
            (f) => f.field.name === src || f.field.attname === src || (src === 'pk' && f.field.primaryKey),
          )
          const alias = ann?.alias ?? fld?.alias
          if (!alias)
            throw new FieldError(`Cannot aggregate over '${src}' on a sliced/distinct/grouped queryset.`)
          ref = `"agg_sub"."${alias}"`
        }
        return Sql.raw(`${e.fn}(${e.distinct ? 'DISTINCT ' : ''}${ref}) AS "x${i}"`)
      })
      query = new Sql(['SELECT '])
        .append(Sql.join(cols))
        .append(' FROM (')
        .append(inner.sql)
        .append(') AS "agg_sub"')
    }
    const { sql, params } = query.render(conn.dialect)
    const { rows } = await conn.execute(sql, params)
    const row = rows[0] ?? {}
    entries.forEach(([name, e], i) => {
      out[name] = e.convertValue(row[`x${i}`], scope)
    })
    return out as any
  }

  // ---- writes -----------------------------------------------------------------------------------

  async create(data: CreateData<T> = {} as CreateData<T>): Promise<T> {
    const Model = this.model as unknown as new (d: unknown) => BaseModel
    const obj = new Model(data)
    await obj.save({ forceInsert: true, using: this.db })
    return obj as unknown as T
  }

  private static lookupParams(lookup: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(lookup)) if (!k.includes(LOOKUP_SEP)) out[k] = v
    return out
  }

  private static resolveDefaults(d: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d ?? {}))
      out[k] = typeof v === 'function' && !(v as any)._meta ? (v as () => unknown)() : v
    return out
  }

  /** `[obj, created]`. Retries the lookup if a concurrent insert wins (IntegrityError). */
  async getOrCreate(
    lookup: Record<string, unknown>,
    opts: { defaults?: Record<string, unknown> } = {},
  ): Promise<[T, boolean]> {
    try {
      return [await this.get(lookup as FilterArg<T>), false]
    } catch (e) {
      if (!(e instanceof this.model.DoesNotExist)) throw e
    }
    const params = { ...QuerySet.lookupParams(lookup), ...QuerySet.resolveDefaults(opts.defaults) }
    try {
      const obj = await atomic(() => this.create(params as CreateData<T>), { using: this.db })
      return [obj, true]
    } catch (e) {
      if (e instanceof IntegrityError) {
        try {
          return [await this.get(lookup as FilterArg<T>), false]
        } catch {}
      }
      throw e
    }
  }

  /** Update the object matching `lookup` with `defaults`, or create it. `[obj, created]`. */
  async updateOrCreate(
    lookup: Record<string, unknown>,
    opts: { defaults?: Record<string, unknown>; createDefaults?: Record<string, unknown> } = {},
  ): Promise<[T, boolean]> {
    return atomic(
      async () => {
        let obj: T | null = null
        try {
          obj = await this.get(lookup as FilterArg<T>)
        } catch (e) {
          if (!(e instanceof this.model.DoesNotExist)) throw e
        }
        if (!obj) {
          const params = {
            ...QuerySet.lookupParams(lookup),
            ...QuerySet.resolveDefaults(opts.createDefaults ?? opts.defaults),
          }
          return [await this.create(params as CreateData<T>), true] as [T, boolean]
        }
        const defaults = QuerySet.resolveDefaults(opts.defaults)
        const meta = this.model._meta
        const updateFields: string[] = []
        for (const [k, v] of Object.entries(defaults)) {
          ;(obj as any)[k] = v
          const f = meta.getForwardField(k)
          if (f?.concrete) updateFields.push(f.name)
        }
        // autoNow fields must be saved too
        for (const f of meta.concreteFields)
          if ((f as any).autoNow && !updateFields.includes(f.name)) updateFields.push(f.name)
        await (obj as unknown as BaseModel).save(
          updateFields.length ? { updateFields, using: this.db } : { using: this.db },
        )
        return [obj, false] as [T, boolean]
      },
      { using: this.db },
    )
  }

  /** Insert many objects with multi-row INSERTs (no signals, like Django). Sets primary keys. */
  async bulkCreate(objs: T[], opts: BulkCreateOptions = {}): Promise<T[]> {
    if (!objs.length) return objs
    const meta = this.model._meta
    for (const o of objs) {
      if (!(o instanceof (this.model as any)))
        throw new TypeError(`bulkCreate() expects ${meta.objectName} instances.`)
    }
    const conn = await this.connection()
    const d = conn.dialect
    const pk = meta.pk
    const using = this.db
    await atomic(
      async () => {
        const tx = await connections.get(using)
        const withPk = objs.filter(
          (o) => (o as any)[pk.attname] !== null && (o as any)[pk.attname] !== undefined,
        )
        const withoutPk = objs.filter((o) => !withPk.includes(o))
        for (const [group, includePk] of [
          [withPk, true],
          [withoutPk, false],
        ] as Array<[T[], boolean]>) {
          if (!group.length) continue
          const fields = meta.concreteFields.filter((f) => includePk || !f.isAutoField)
          const perStatement = Math.max(
            1,
            Math.floor(tx.features.maxQueryParams / Math.max(1, fields.length)),
          )
          const size = Math.min(perStatement, opts.batchSize ?? perStatement)
          for (const batch of chunk(group, size)) {
            const rows = batch.map((o) => {
              const vals = fields.map((f) => {
                const v = f.preSave(o as unknown as BaseModel, true)
                return v === null || v === undefined ? Sql.raw('NULL') : f.dbParam(v, d)
              })
              return Sql.join(vals).wrap('(', ')')
            })
            const q = new Sql(['INSERT INTO ']).append(ident(meta.dbTable))
            if (fields.length) {
              q.append(' (')
                .append(Sql.join(fields.map((f) => ident(f.column))))
                .append(') VALUES ')
                .append(Sql.join(rows))
            } else q.append(' DEFAULT VALUES')
            if (opts.ignoreConflicts) q.append(' ON CONFLICT DO NOTHING')
            q.append(' RETURNING ').append(ident(pk.column))
            const { sql, params } = q.render(d)
            const res = await tx.execute(sql, params)
            if (!includePk && !opts.ignoreConflicts) {
              res.rows.forEach((row, i) => {
                if (batch[i]) (batch[i] as any)[pk.attname] = pk.fromDb(row[pk.column], d)
              })
            }
            for (const o of batch) {
              const st = (o as unknown as BaseModel)._state
              if (!opts.ignoreConflicts || includePk) {
                st.adding = false
                st.db = using
              }
            }
          }
        }
      },
      { using },
    )
    return objs
  }

  /** Update `fields` of many saved objects with CASE expressions. Returns rows matched. */
  async bulkUpdate(objs: T[], fields: string[], opts: { batchSize?: number } = {}): Promise<number> {
    if (!objs.length) return 0
    const meta = this.model._meta
    const flds = fields.map((n) => {
      const f = meta.getForwardField(n)
      if (!f?.concrete) throw new FieldError(`bulkUpdate() can only be used with concrete fields ('${n}').`)
      if (f.primaryKey) throw new FieldError('bulkUpdate() cannot be used with primary key fields.')
      return f
    })
    const conn = await this.connection()
    const d = conn.dialect
    const pk = meta.pk
    const perObj = flds.length * 2 + 1
    const size = Math.min(
      Math.max(1, Math.floor(conn.features.maxQueryParams / perObj)),
      opts.batchSize ?? Number.POSITIVE_INFINITY,
    )
    let total = 0
    await atomic(
      async () => {
        const tx = await connections.get(this.db)
        for (const batch of chunk(objs, size)) {
          const sets = flds.map((f) => {
            const cases = new Sql(['CASE ']).append(ident(pk.column))
            for (const o of batch) {
              const v = (o as any)[f.attname]
              let param = v === null || v === undefined ? Sql.raw('NULL') : f.dbParam(v, d)
              const t = f.dbType(d)
              if (d === 'postgresql' && t && f.internalType !== 'JSONField')
                param = param.wrap('CAST(', ` AS ${t})`)
              cases
                .append(' WHEN ')
                .append(pk.dbParam((o as any)[pk.attname], d))
                .append(' THEN ')
                .append(param)
            }
            cases.append(' END')
            return new Sql().append(ident(f.column)).append(' = ').append(cases)
          })
          const q = new Sql(['UPDATE '])
            .append(ident(meta.dbTable))
            .append(' SET ')
            .append(Sql.join(sets))
            .append(' WHERE ')
            .append(ident(pk.column))
            .append(' IN (')
            .append(Sql.join(batch.map((o) => pk.dbParam((o as any)[pk.attname], d))))
            .append(')')
          const { sql, params } = q.render(d)
          total += (await tx.execute(sql, params)).rowsAffected ?? 0
        }
      },
      { using: this.db },
    )
    return total
  }

  /** `Map<id, obj>` for the given ids (or all rows). */
  async inBulk(ids?: unknown[], opts: { fieldName?: string } = {}): Promise<Map<unknown, T>> {
    const meta = this.model._meta
    const fieldName = opts.fieldName ?? 'pk'
    const field = fieldName === 'pk' ? meta.pk : meta.getForwardField(fieldName)
    if (!field || !(field.unique || field.primaryKey))
      throw new FieldError(`inBulk()'s fieldName must be a unique field but '${fieldName}' isn't.`)
    const out = new Map<unknown, T>()
    if (ids && !ids.length) return out
    const qs = ids ? this.filter({ [`${field.name}__in`]: ids } as FilterArg<T>) : this.all()
    for (const obj of await qs.orderBy().fetch()) out.set((obj as any)[field.attname], obj)
    return out
  }

  /** SQL UPDATE of every matched row; returns the number of rows. No signals, no autoNow. */
  async update(values: Record<string, unknown>): Promise<number> {
    this.assertNotSliced('update')
    if (this.state.isNone || !Object.keys(values).length) return 0
    const conn = await this.connection()
    const compiler = new Compiler(conn.dialect, conn.features)
    const { sql, params } = compileUpdate({ ...this.state, ordering: [] }, compiler, values).render(
      conn.dialect,
    )
    const res = await conn.execute(sql, params)
    this._resultCache = null
    return res.rowsAffected ?? 0
  }

  /** Delete matched rows, emulating `onDelete` and sending signals. Returns `[total, { label: n }]`. */
  async delete(): Promise<[number, Record<string, number>]> {
    if (isSliced(this.state)) throw new TypeError("Cannot use 'limit' or 'offset' with delete().")
    if (this.state.values) throw new TypeError('Cannot call delete() after values() or valuesList().')
    if (this.state.isNone) return [0, {}]
    const collector = new Collector(this.db)
    await collector.collectQuerySet(this as unknown as QuerySet<BaseModel>)
    this._resultCache = null
    return collector.delete()
  }

  // ---- debugging --------------------------------------------------------------------------------

  /** The compiled SELECT for the alias' dialect: `{ sql, params }`. */
  toSQL(dialect = connections.dialect(this.db)): { sql: string; params: unknown[] } {
    const compiler = new Compiler(dialect)
    const { sql } = compileSelect(this.state, compiler)
    return sql.render(dialect)
  }

  toString(): string {
    return `<QuerySet ${this.model.name}>`
  }
}

export { Prefetch }
