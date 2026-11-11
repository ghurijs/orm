import { ImproperlyConfigured } from '@ghuri/core'
import { wrapDatabaseError } from '../errors'
import { drizzle } from 'drizzle-orm/d1'
import { BaseConnection } from './base'
import type { Connection, DatabaseConfig, DatabaseFeatures, ExecuteResult } from './types'

/** Structural subset of Cloudflare's `D1Database` (no dependency on workers-types at runtime). */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<Array<{ results?: unknown[]; meta?: any }>>
  exec(query: string): Promise<unknown>
}
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  all(): Promise<{ results?: unknown[]; meta?: any }>
  run(): Promise<{ results?: unknown[]; meta?: any }>
}

export class D1Connection extends BaseConnection {
  readonly vendor = 'd1' as const
  readonly dialect = 'sqlite' as const
  readonly features: DatabaseFeatures = {
    supportsTransactions: false,
    supportsSavepoints: false,
    maxQueryParams: 100,
    supportsRegex: false,
  }

  constructor(readonly db: D1DatabaseLike) {
    super()
  }

  protected createDrizzle(): any {
    return drizzle(this.db as any)
  }

  protected async run(sql: string, params: unknown[]): Promise<ExecuteResult> {
    const stmt = params.length ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql)
    const res = await stmt.all()
    const rows = (res.results ?? []) as Record<string, unknown>[]
    return {
      rows,
      rowsAffected: res.meta?.changes,
      lastInsertId: res.meta?.last_row_id,
    }
  }

  /** D1 batches are atomic: all statements commit or none do. */
  override async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<ExecuteResult[]> {
    if (!statements.length) return []
    const prepared = statements.map((s) => {
      const p = this.normalizeParams(s.params ?? [])
      return p.length ? this.db.prepare(s.sql).bind(...p) : this.db.prepare(s.sql)
    })
    try {
      const results = await this.db.batch(prepared)
      return results.map((r) => ({
        rows: (r.results ?? []) as Record<string, unknown>[],
        rowsAffected: r.meta?.changes,
        lastInsertId: r.meta?.last_row_id,
      }))
    } catch (err) {
      throw wrapDatabaseError(err, statements.map((s) => s.sql).join('; '))
    }
  }

  /** No interactive transactions on D1: runs `fn` directly (best effort, no rollback). */
  override async transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async executeScript(sql: string): Promise<void> {
    // D1's exec() splits on newlines; run statement by statement instead for clearer errors.
    for (const stmt of splitStatements(sql)) await this.execute(stmt)
  }

  async close(): Promise<void> {}
}

/** Split a SQL script on `;` outside of quotes. */
export function splitStatements(script: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
    } else if (ch === '-' && script[i + 1] === '-') {
      while (i < script.length && script[i] !== '\n') i++
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Cloudflare D1 database from a Worker binding name (`d1('DB')` → `env.DB`). A `D1Database` object can
 * also be passed directly (tests).
 */
export function d1(binding: string | D1DatabaseLike): DatabaseConfig {
  return {
    vendor: 'd1',
    dialect: 'sqlite',
    options: { binding: typeof binding === 'string' ? binding : '<D1Database>' },
    connect(env) {
      const db = typeof binding === 'string' ? (env?.[binding] as D1DatabaseLike | undefined) : binding
      if (!db || typeof db.prepare !== 'function') {
        throw new ImproperlyConfigured(
          `D1 binding '${String(binding)}' not found in env. Add it to wrangler.jsonc (d1_databases) or use another DATABASES backend.`,
        )
      }
      return new D1Connection(db)
    },
  }
}
