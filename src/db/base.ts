import { wrapDatabaseError } from '../errors'
import type { Dialect } from '../query/sql'
import { globalSingleton } from '../utils'
import type { Connection, DatabaseFeatures, ExecuteResult, Vendor } from './types'

export interface QueryEvent {
  alias: string
  vendor: Vendor
  sql: string
  params: unknown[]
  durationMs: number
}
type QueryListener = (e: QueryEvent) => void

const listeners: Set<QueryListener> = globalSingleton(
  'ghuri.orm.queryListeners',
  () => new Set<QueryListener>(),
)

/** Observe every executed statement (tests use it to count queries). Returns an unsubscribe function. */
export function onQuery(listener: QueryListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Run `fn` and return the statements it executed: `const [result, queries] = await captureQueries(fn)`. */
export async function captureQueries<T>(fn: () => Promise<T>): Promise<[T, QueryEvent[]]> {
  const events: QueryEvent[] = []
  const off = onQuery((e) => events.push(e))
  try {
    return [await fn(), events]
  } finally {
    off()
  }
}

/** Normalize JS values for SQLite-family drivers (better-sqlite3 / D1). */
export function sqliteParam(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return v
}

export function pgParam(v: unknown): unknown {
  if (v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  return v
}

/**
 * Shared connection behavior: error normalization, query events, BEGIN/COMMIT transactions for
 * single-connection drivers (better-sqlite3, PGlite). Subclasses implement `run()`.
 */
export abstract class BaseConnection implements Connection {
  abstract readonly vendor: Vendor
  abstract readonly dialect: Dialect
  abstract readonly features: DatabaseFeatures
  alias = 'default'
  protected _drizzle: any
  protected txDepth = 0

  get supportsTransactions(): boolean {
    return this.features.supportsTransactions
  }

  get drizzle(): any {
    if (this._drizzle === undefined) this._drizzle = this.createDrizzle()
    return this._drizzle
  }

  protected abstract createDrizzle(): any
  protected abstract run(sql: string, params: unknown[]): Promise<ExecuteResult>
  abstract executeScript(sql: string): Promise<void>
  abstract close(): Promise<void>

  protected normalizeParams(params: unknown[]): unknown[] {
    return this.dialect === 'sqlite' ? params.map(sqliteParam) : params.map(pgParam)
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const start = listeners.size ? performance.now() : 0
    const normalized = this.normalizeParams(params)
    try {
      return await this.run(sql, normalized)
    } catch (err) {
      throw wrapDatabaseError(err, sql)
    } finally {
      if (listeners.size) {
        const event: QueryEvent = {
          alias: this.alias,
          vendor: this.vendor,
          sql,
          params: normalized,
          durationMs: performance.now() - start,
        }
        for (const l of listeners) l(event)
      }
    }
  }

  async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<ExecuteResult[]> {
    return this.transaction(async (conn) => {
      const out: ExecuteResult[] = []
      for (const s of statements) out.push(await conn.execute(s.sql, s.params ?? []))
      return out
    })
  }

  /** BEGIN/COMMIT on the single underlying connection; nested calls are no-ops (use atomic() for savepoints). */
  async transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    if (!this.features.supportsTransactions || this.txDepth > 0) return fn(this)
    await this.execute('BEGIN')
    this.txDepth++
    try {
      const result = await fn(this)
      this.txDepth--
      await this.execute('COMMIT')
      return result
    } catch (err) {
      this.txDepth--
      try {
        await this.execute('ROLLBACK')
      } catch {}
      throw err
    }
  }
}
