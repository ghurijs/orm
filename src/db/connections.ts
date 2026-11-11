import { AsyncLocalStorage } from 'node:async_hooks'
import { type GhuriContext, ImproperlyConfigured, requestFinished, tryGetContext } from '@ghuri/core'
import { TransactionManagementError } from '../errors'
import type { Dialect } from '../query/sql'
import { globalSingleton } from '../utils'
import type { Connection, DatabaseConfig } from './types'

export const DEFAULT_DB_ALIAS = 'default'

const STATE_KEY = Symbol.for('ghuri.orm.connections')
const GLOBAL_CTX_KEY = Symbol.for('ghuri.core.globalContext')

interface AtomicFrame {
  alias: string
  conn: Connection
  depth: number
  savepointCounter: number
  onCommit: Array<() => unknown | Promise<unknown>>
  /** False on backends without transactions (D1): atomic() is best effort there. */
  transactional: boolean
}

const atomicStorage: AsyncLocalStorage<Map<string, AtomicFrame>> = globalSingleton(
  'ghuri.orm.atomicStorage',
  () => new AsyncLocalStorage<Map<string, AtomicFrame>>(),
)

function currentFrame(alias: string): AtomicFrame | undefined {
  return atomicStorage.getStore()?.get(alias)
}

function requireContext(): GhuriContext {
  const ctx = tryGetContext()
  if (!ctx) {
    throw new ImproperlyConfigured(
      'No Ghuri context: database access must happen inside a request, runWithContext(), app.setup(env) or setupTestDatabase().',
    )
  }
  return ctx
}

function cacheFor(ctx: GhuriContext): Map<string, Promise<Connection>> {
  let cache = ctx.state.get(STATE_KEY) as Map<string, Promise<Connection>> | undefined
  if (!cache) {
    cache = new Map()
    ctx.state.set(STATE_KEY, cache)
  }
  return cache
}

/** `DATABASES[alias]` from the current settings. */
export function getDatabaseConfig(alias: string = DEFAULT_DB_ALIAS): DatabaseConfig {
  const ctx = requireContext()
  const config = ctx.settings.DATABASES?.[alias]
  if (!config) throw new ImproperlyConfigured(`The connection '${alias}' doesn't exist (settings.DATABASES).`)
  return config
}

/**
 * Connection handler. Connections are cached in the current `GhuriContext.state` — per request on
 * Workers (I/O can't be shared across requests), per process when only the global context exists
 * (Node, CLI, tests). Inside `atomic()` the transaction's connection is returned.
 */
export const connections = {
  async get(alias: string = DEFAULT_DB_ALIAS): Promise<Connection> {
    const frame = currentFrame(alias)
    if (frame) return frame.conn
    const ctx = requireContext()
    const cache = cacheFor(ctx)
    let pending = cache.get(alias)
    if (!pending) {
      const config = getDatabaseConfig(alias)
      pending = Promise.resolve(config.connect(ctx.env)).then((conn) => {
        conn.alias = alias
        return conn
      })
      pending.catch(() => cache.delete(alias))
      cache.set(alias, pending)
    }
    return pending
  },

  /** Dialect of an alias without connecting (sync). Defaults to 'sqlite' outside a context. */
  dialect(alias: string = DEFAULT_DB_ALIAS): Dialect {
    const frame = currentFrame(alias)
    if (frame) return frame.conn.dialect
    const ctx = tryGetContext()
    return ctx?.settings.DATABASES?.[alias]?.dialect ?? 'sqlite'
  },

  /** Close and forget every connection cached in the current context. */
  async closeAll(): Promise<void> {
    const ctx = tryGetContext()
    if (!ctx) return
    await closeContextConnections(ctx)
  },

  /** Forget a cached connection without closing it (tests swapping databases). */
  reset(alias?: string): void {
    const ctx = tryGetContext()
    if (!ctx) return
    const cache = cacheFor(ctx)
    if (alias) cache.delete(alias)
    else cache.clear()
  },

  /** Is `alias` currently inside atomic()? */
  inAtomicBlock(alias: string = DEFAULT_DB_ALIAS): boolean {
    return currentFrame(alias) !== undefined
  },
}

async function closeContextConnections(ctx: GhuriContext, keepPersistent = false): Promise<void> {
  const cache = ctx.state.get(STATE_KEY) as Map<string, Promise<Connection>> | undefined
  if (!cache) return
  const pending = [...cache.values()]
  cache.clear()
  await Promise.all(
    pending.map(async (p) => {
      const conn = await p.catch(() => null)
      if (!conn || (keepPersistent && (conn as { persistent?: boolean }).persistent)) return
      await conn.close()
    }),
  )
}

// Close per-request connections when a request finishes (Workers): never the global (process) ones.
globalSingleton('ghuri.orm.requestFinishedHook', () => {
  requestFinished.connect(
    async () => {
      const ctx = tryGetContext()
      if (!ctx || ctx === (globalThis as any)[GLOBAL_CTX_KEY]) return
      const done = closeContextConnections(ctx, true)
      if (ctx.executionCtx) ctx.executionCtx.waitUntil(done)
      else await done
    },
    { uid: 'ghuri.orm.closeConnections' },
  )
  return true
})

/** The drizzle instance of a connection (escape hatch). */
export async function getDrizzle(alias: string = DEFAULT_DB_ALIAS): Promise<any> {
  return (await connections.get(alias)).drizzle
}

function quoteSp(name: string): string {
  return `"${name}"`
}

/**
 * Run `fn` in a transaction. Nested calls create savepoints. Inside the callback every query on the alias
 * goes through the transaction's connection.
 *
 * D1 has no interactive transactions: `atomic()` runs the callback without isolation or rollback
 * (best effort) and still defers `onCommit` callbacks until it returns successfully. Use
 * `connection.batch()` for all-or-nothing groups of statements on D1.
 */
export async function atomic<T>(
  fn: () => Promise<T>,
  opts: { using?: string; savepoint?: boolean } = {},
): Promise<T> {
  const alias = opts.using ?? DEFAULT_DB_ALIAS
  const frame = currentFrame(alias)
  if (frame) {
    if (!frame.transactional || opts.savepoint === false || !frame.conn.features.supportsSavepoints)
      return fn()
    const sp = `ghuri_sp_${++frame.savepointCounter}`
    const commitMark = frame.onCommit.length
    await frame.conn.execute(`SAVEPOINT ${quoteSp(sp)}`)
    frame.depth++
    try {
      const result = await fn()
      await frame.conn.execute(`RELEASE SAVEPOINT ${quoteSp(sp)}`)
      return result
    } catch (err) {
      await frame.conn.execute(`ROLLBACK TO SAVEPOINT ${quoteSp(sp)}`)
      await frame.conn.execute(`RELEASE SAVEPOINT ${quoteSp(sp)}`)
      frame.onCommit.length = commitMark
      throw err
    } finally {
      frame.depth--
    }
  }

  const conn = await connections.get(alias)
  const run = async (txConn: Connection, transactional: boolean): Promise<[T, AtomicFrame]> => {
    const newFrame: AtomicFrame = {
      alias,
      conn: txConn,
      depth: 1,
      savepointCounter: 0,
      onCommit: [],
      transactional,
    }
    const store = new Map(atomicStorage.getStore() ?? [])
    store.set(alias, newFrame)
    const result = await atomicStorage.run(store, fn)
    return [result, newFrame]
  }
  let result: T
  let finished: AtomicFrame
  if (conn.supportsTransactions) {
    ;[result, finished] = await conn.transaction((tx) => run(tx, true))
  } else {
    ;[result, finished] = await run(conn, false)
  }
  for (const cb of finished.onCommit) await cb()
  return result
}

/** Run `fn` after the outermost atomic block commits (immediately when not in a transaction). */
export async function onCommit(
  fn: () => unknown | Promise<unknown>,
  opts: { using?: string } = {},
): Promise<void> {
  const frame = currentFrame(opts.using ?? DEFAULT_DB_ALIAS)
  if (frame) frame.onCommit.push(fn)
  else await fn()
}

/** Throw if not inside atomic() (Django's `transaction.get_autocommit()` check for APIs that need one). */
export function assertInAtomic(alias: string = DEFAULT_DB_ALIAS): void {
  if (!currentFrame(alias)) throw new TransactionManagementError('This code must run inside atomic().')
}
