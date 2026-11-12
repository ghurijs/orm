import { AsyncLocalStorage } from 'node:async_hooks'
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

/** Holder of a connection's lock: an open transaction, or one statement from outside it. */
interface LockToken {
  release(): void
}

/**
 * Transactions (lock tokens) the current async context opened, on any connection. Code that runs in that
 * context (awaits, `Promise.all` children, nested `atomic()`) uses the open transaction directly.
 */
const ownedTransactions: AsyncLocalStorage<ReadonlySet<LockToken>> = globalSingleton(
  'ghuri.orm.ownedTransactions',
  () => new AsyncLocalStorage<ReadonlySet<LockToken>>(),
)

/** FIFO async mutex of one connection. */
class ConnectionLock {
  holder: LockToken | undefined
  private tail: Promise<void> = Promise.resolve()

  async acquire(): Promise<LockToken> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const token: LockToken = {
      release: () => {
        if (this.holder === token) this.holder = undefined
        release()
      },
    }
    this.holder = token
    return token
  }
}

/**
 * Shared connection behavior: error normalization, query events, BEGIN/COMMIT transactions for
 * single-connection drivers (better-sqlite3, PGlite). Subclasses implement `run()`.
 *
 * On those drivers one connection (one session) is shared by every concurrent request of the process and a
 * transaction covers the whole connection, so the connection is guarded by a FIFO lock: an outermost
 * transaction holds it from BEGIN to COMMIT/ROLLBACK, and statements from other async contexts (other
 * transactions, plain autocommit queries) wait until it is released instead of running inside it. Code in
 * the async context that opened the transaction (nested `atomic()` → savepoints, `Promise.all` children)
 * uses it directly. Django gets the same isolation from one connection per thread.
 */
export abstract class BaseConnection implements Connection {
  abstract readonly vendor: Vendor
  abstract readonly dialect: Dialect
  abstract readonly features: DatabaseFeatures
  alias = 'default'
  protected _drizzle: any
  private readonly lock = new ConnectionLock()

  get supportsTransactions(): boolean {
    return this.features.supportsTransactions
  }

  /**
   * True when a transaction covers this whole connection object (one shared session: better-sqlite3,
   * PGlite), so statements from other async contexts must wait for it. False on D1 (no transactions) and
   * pooled drivers whose transactions run on a reserved connection (postgres.js).
   */
  protected get connectionWideTransactions(): boolean {
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

  /** Does the current async context own this connection's open transaction? */
  protected inOwnTransaction(): boolean {
    const holder = this.lock.holder
    return holder !== undefined && ownedTransactions.getStore()?.has(holder) === true
  }

  /**
   * Run `fn` (one statement or script) on the connection, after any transaction opened by another async
   * context has finished. Runs directly inside the caller's own transaction and on backends without
   * connection-wide transactions.
   */
  protected async serialized<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.connectionWideTransactions || this.inOwnTransaction()) return fn()
    const token = await this.lock.acquire()
    try {
      return await fn()
    } finally {
      token.release()
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    return this.serialized(() => this.executeNow(sql, params))
  }

  private async executeNow(sql: string, params: unknown[]): Promise<ExecuteResult> {
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

  /**
   * BEGIN/COMMIT on the single underlying connection, holding the connection's lock until COMMIT/ROLLBACK
   * (concurrent transactions from other async contexts queue). Calls from inside the caller's own
   * transaction run `fn` directly (use atomic() for savepoints).
   */
  async transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    if (!this.features.supportsTransactions || this.inOwnTransaction()) return fn(this)
    const token = await this.lock.acquire()
    const owned = new Set(ownedTransactions.getStore() ?? [])
    owned.add(token)
    try {
      return await ownedTransactions.run(owned, async () => {
        await this.execute('BEGIN')
        try {
          const result = await fn(this)
          await this.execute('COMMIT')
          return result
        } catch (err) {
          try {
            await this.execute('ROLLBACK')
          } catch {}
          throw err
        }
      })
    } finally {
      token.release()
    }
  }
}
