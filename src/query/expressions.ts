import type { Field } from '../fields/base'
import { type Dialect, Param, Sql } from './sql'

/** What expressions need from the compiler (implemented by `Scope` in compiler.ts). */
export interface CompileScope {
  readonly dialect: Dialect
  /** Column or annotation reference (`F('author__name')`). */
  compileRef(name: string): Sql
  /** Output field of a reference (no side effects). */
  refField(name: string): Field<any, any> | undefined
  compileAggregate(agg: Aggregate): Sql
  compileQ(q: QNode): Sql
  /** Plain value as a parameter, converted with `field` when given. */
  compileValue(value: unknown, field?: Field<any, any>): Sql
}

export interface OrderByOptions {
  nullsFirst?: boolean
  nullsLast?: boolean
}

export abstract class Expression {
  abstract compile(scope: CompileScope): Sql

  /** The field describing the expression's result (drives value conversion). */
  outputField(_scope: CompileScope): Field<any, any> | undefined {
    return undefined
  }

  get containsAggregate(): boolean {
    return false
  }

  /** Convert a raw database value of this expression. */
  convertValue(value: unknown, scope: CompileScope): unknown {
    if (value === null || value === undefined) return null
    const f = this.outputField(scope)
    return f ? f.fromDb(value, scope.dialect) : value
  }

  add(other: unknown): CombinedExpression {
    return new CombinedExpression(this, '+', other)
  }
  sub(other: unknown): CombinedExpression {
    return new CombinedExpression(this, '-', other)
  }
  mul(other: unknown): CombinedExpression {
    return new CombinedExpression(this, '*', other)
  }
  div(other: unknown): CombinedExpression {
    return new CombinedExpression(this, '/', other)
  }
  mod(other: unknown): CombinedExpression {
    return new CombinedExpression(this, '%', other)
  }
  asc(opts: OrderByOptions = {}): OrderBy {
    return new OrderBy(this, false, opts)
  }
  desc(opts: OrderByOptions = {}): OrderBy {
    return new OrderBy(this, true, opts)
  }
}

export function toExpression(v: unknown): Expression {
  return v instanceof Expression ? v : new ValueExpression(v)
}

/** Reference to a field or annotation: `F('views')`, `F('author__username')`. */
export class FExpression extends Expression {
  constructor(readonly name: string) {
    super()
  }
  compile(scope: CompileScope): Sql {
    return scope.compileRef(this.name)
  }
  override outputField(scope: CompileScope): Field<any, any> | undefined {
    return scope.refField(this.name)
  }
  toString(): string {
    return `F(${this.name})`
  }
}

export function F(name: string): FExpression {
  return new FExpression(name)
}

/** A literal value (parameter). */
export class ValueExpression extends Expression {
  constructor(
    readonly value: unknown,
    readonly field?: Field<any, any>,
  ) {
    super()
  }
  compile(scope: CompileScope): Sql {
    return scope.compileValue(this.value, this.field)
  }
  override outputField(): Field<any, any> | undefined {
    return this.field
  }
  override convertValue(value: unknown, scope: CompileScope): unknown {
    if (this.field) return super.convertValue(value, scope)
    if (typeof this.value === 'boolean' && (value === 0 || value === 1)) return value === 1
    return value
  }
}

export function Value(value: unknown, field?: Field<any, any>): ValueExpression {
  return new ValueExpression(value, field)
}

export class CombinedExpression extends Expression {
  readonly lhs: Expression
  readonly rhs: Expression
  constructor(
    lhs: unknown,
    readonly op: '+' | '-' | '*' | '/' | '%',
    rhs: unknown,
  ) {
    super()
    this.lhs = toExpression(lhs)
    this.rhs = toExpression(rhs)
  }
  compile(scope: CompileScope): Sql {
    const s = new Sql(['('])
    s.append(this.lhs.compile(scope))
    s.append(` ${this.op} `)
    s.append(this.rhs.compile(scope))
    s.append(')')
    return s
  }
  override outputField(scope: CompileScope): Field<any, any> | undefined {
    return this.lhs.outputField(scope) ?? this.rhs.outputField(scope)
  }
  override get containsAggregate(): boolean {
    return this.lhs.containsAggregate || this.rhs.containsAggregate
  }
}

/** Raw SQL with `?` placeholders: `RawSQL('LENGTH("title") > ?', [5])`. Not portable by nature. */
export class RawSQL extends Expression {
  constructor(
    readonly text: string,
    readonly params: unknown[] = [],
    readonly field?: Field<any, any>,
  ) {
    super()
  }
  compile(): Sql {
    const parts = this.text.split('?')
    const out = new Sql()
    parts.forEach((p, i) => {
      out.chunks.push(p)
      if (i < parts.length - 1) out.chunks.push(new Param(this.params[i]))
    })
    return out
  }
  override outputField(): Field<any, any> | undefined {
    return this.field
  }
}

/** SQL function call. String arguments are field references. */
export class Func extends Expression {
  readonly args: Expression[]
  constructor(
    readonly fn: string,
    args: unknown[],
    readonly field?: Field<any, any>,
  ) {
    super()
    this.args = args.map((a) => (typeof a === 'string' ? new FExpression(a) : toExpression(a)))
  }
  protected functionName(_dialect: Dialect): string {
    return this.fn
  }
  compile(scope: CompileScope): Sql {
    const out = new Sql([`${this.functionName(scope.dialect)}(`])
    out.append(Sql.join(this.args.map((a) => a.compile(scope))))
    out.append(')')
    return out
  }
  override outputField(scope: CompileScope): Field<any, any> | undefined {
    return this.field ?? this.args[0]?.outputField(scope)
  }
  override get containsAggregate(): boolean {
    return this.args.some((a) => a.containsAggregate)
  }
}

export const Lower = (expr: string | Expression): Func => new Func('LOWER', [expr])
export const Upper = (expr: string | Expression): Func => new Func('UPPER', [expr])
export const Coalesce = (...exprs: Array<string | Expression>): Func => new Func('COALESCE', exprs)

class LengthFunc extends Func {
  override convertValue(value: unknown): unknown {
    return value === null || value === undefined ? null : Number(value)
  }
}
export const Length = (expr: string | Expression): Func => new LengthFunc('LENGTH', [expr])

/** String concatenation; NULLs are treated as empty strings (same on both dialects). */
export class ConcatExpression extends Expression {
  readonly parts: Expression[]
  constructor(parts: unknown[]) {
    super()
    this.parts = parts.map((a) => (typeof a === 'string' ? new FExpression(a) : toExpression(a)))
  }
  compile(scope: CompileScope): Sql {
    const pieces = this.parts.map((p) => {
      const inner = p.compile(scope)
      return scope.dialect === 'postgresql'
        ? inner.wrap('COALESCE(CAST(', " AS text), '')")
        : inner.wrap('COALESCE(', ", '')")
    })
    return Sql.join(pieces, ' || ').wrap('(', ')')
  }
}
/** `Concat('firstName', Value(' '), 'lastName')` */
export const Concat = (...parts: unknown[]): ConcatExpression => new ConcatExpression(parts)

/** Current timestamp (as `Date`). */
export class NowExpression extends Expression {
  compile(scope: CompileScope): Sql {
    return scope.dialect === 'postgresql'
      ? Sql.raw('CURRENT_TIMESTAMP')
      : Sql.raw("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  }
  override convertValue(value: unknown): unknown {
    return value === null || value === undefined
      ? null
      : value instanceof Date
        ? value
        : new Date(String(value))
  }
}
export const Now = (): NowExpression => new NowExpression()

// ---- aggregates ---------------------------------------------------------------------------------

export type AggregateFunction = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'

export interface AggregateOptions {
  distinct?: boolean
  /** Only aggregate rows matching this Q (paths relative to the queried model). */
  filter?: QNode | Record<string, unknown>
}

export class Aggregate extends Expression {
  readonly filter?: QNode
  readonly distinct: boolean
  constructor(
    readonly fn: AggregateFunction,
    readonly source: string | Expression,
    opts: AggregateOptions = {},
  ) {
    super()
    this.distinct = opts.distinct ?? false
    this.filter = opts.filter ? (opts.filter instanceof QNode ? opts.filter : Q(opts.filter)) : undefined
  }
  override get containsAggregate(): boolean {
    return true
  }
  compile(scope: CompileScope): Sql {
    return scope.compileAggregate(this)
  }
  sourceField(scope: CompileScope): Field<any, any> | undefined {
    if (this.source === '*') return undefined
    return typeof this.source === 'string' ? scope.refField(this.source) : this.source.outputField(scope)
  }
  override outputField(scope: CompileScope): Field<any, any> | undefined {
    if (this.fn === 'COUNT') return undefined
    return this.sourceField(scope)
  }
  override convertValue(value: unknown, scope: CompileScope): unknown {
    if (this.fn === 'COUNT') return value === null || value === undefined ? 0 : Number(value)
    if (value === null || value === undefined) return null
    const f = this.sourceField(scope)
    if (this.fn === 'AVG') {
      if (f && f.internalType === 'DecimalField') return f.fromDb(value, scope.dialect)
      return Number(value)
    }
    if (f) {
      if (this.fn === 'SUM' && f.internalType !== 'DecimalField' && f.internalType !== 'DurationField') {
        return Number(value)
      }
      return f.fromDb(value, scope.dialect)
    }
    return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  }
  toString(): string {
    return `${this.fn}(${String(this.source)})`
  }
}

export const Count = (source: string | Expression = '*', opts?: AggregateOptions): Aggregate =>
  new Aggregate('COUNT', source, opts)
export const Sum = (source: string | Expression, opts?: AggregateOptions): Aggregate =>
  new Aggregate('SUM', source, opts)
export const Avg = (source: string | Expression, opts?: AggregateOptions): Aggregate =>
  new Aggregate('AVG', source, opts)
export const Min = (source: string | Expression, opts?: AggregateOptions): Aggregate =>
  new Aggregate('MIN', source, opts)
export const Max = (source: string | Expression, opts?: AggregateOptions): Aggregate =>
  new Aggregate('MAX', source, opts)

// ---- ordering -----------------------------------------------------------------------------------

export class OrderBy {
  constructor(
    readonly expression: Expression,
    readonly descending: boolean,
    readonly opts: OrderByOptions = {},
  ) {}
  reversed(): OrderBy {
    const { nullsFirst, nullsLast } = this.opts
    return new OrderBy(this.expression, !this.descending, { nullsFirst: nullsLast, nullsLast: nullsFirst })
  }
}

// ---- Q objects ----------------------------------------------------------------------------------

export type QChild = [string, unknown] | QNode

/** A tree of filter conditions combined with AND / OR and optionally negated. */
export class QNode {
  constructor(
    readonly children: QChild[] = [],
    readonly connector: 'AND' | 'OR' = 'AND',
    readonly negated = false,
  ) {}

  static from(filters: Record<string, unknown> | QNode): QNode {
    if (filters instanceof QNode) return filters
    return new QNode(Object.entries(filters))
  }

  get isEmpty(): boolean {
    return this.children.length === 0
  }

  private combine(other: QNode | Record<string, unknown>, connector: 'AND' | 'OR'): QNode {
    const o = QNode.from(other)
    if (o.isEmpty) return this
    if (this.isEmpty) return o
    return new QNode([this, o], connector)
  }

  and(...others: Array<QNode | Record<string, unknown>>): QNode {
    return others.reduce<QNode>((acc, o) => acc.combine(o, 'AND'), this)
  }

  or(...others: Array<QNode | Record<string, unknown>>): QNode {
    return others.reduce<QNode>((acc, o) => acc.combine(o, 'OR'), this)
  }

  /** Negated copy (`~Q` in Django). */
  not(): QNode {
    return new QNode(this.children, this.connector, !this.negated)
  }

  negate(): QNode {
    return this.not()
  }

  toString(): string {
    const inner = this.children
      .map((c) => (c instanceof QNode ? c.toString() : `${c[0]}=${JSON.stringify(c[1])}`))
      .join(` ${this.connector} `)
    return `${this.negated ? 'NOT ' : ''}(${inner})`
  }
}

/** `Q({ a: 1 })`, `Q({ a: 1 }).or(Q({ b: 2 }))`, `Q.not({ c: 3 })` */
export function Q(...filters: Array<Record<string, unknown> | QNode>): QNode {
  if (filters.length === 1) return QNode.from(filters[0])
  return new QNode(filters.map((f) => QNode.from(f)))
}
Q.not = (...filters: Array<Record<string, unknown> | QNode>): QNode => Q(...filters).not()
Q.and = (...filters: Array<Record<string, unknown> | QNode>): QNode =>
  new QNode(
    filters.map((f) => QNode.from(f)),
    'AND',
  )
Q.or = (...filters: Array<Record<string, unknown> | QNode>): QNode =>
  new QNode(
    filters.map((f) => QNode.from(f)),
    'OR',
  )

/** Type of `Q(...)` results. */
export type Q = QNode
