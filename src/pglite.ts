// @ghuri/orm/pglite — PostgreSQL dialect in-process via PGlite (tests / local dev).
import { PGlite, types } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { BaseConnection } from './db/base'
import type { DatabaseConfig, DatabaseFeatures, ExecuteResult } from './db/types'

export class PGliteConnection extends BaseConnection {
  readonly vendor = 'pglite' as const
  readonly dialect = 'postgresql' as const
  readonly features: DatabaseFeatures = {
    supportsTransactions: true,
    supportsSavepoints: true,
    maxQueryParams: 65535,
    supportsRegex: true,
  }
  /** Shared by every context in the process; never closed at request end. */
  readonly persistent = true

  constructor(readonly pg: PGlite) {
    super()
  }

  protected createDrizzle(): any {
    return drizzle(this.pg as any)
  }

  protected async run(sql: string, params: unknown[]): Promise<ExecuteResult> {
    const res = await this.pg.query<Record<string, unknown>>(sql, params, { rowMode: 'object' })
    return { rows: res.rows, rowsAffected: res.affectedRows ?? res.rows.length }
  }

  async executeScript(sql: string): Promise<void> {
    await this.pg.exec(sql)
  }

  async close(): Promise<void> {
    if (!this.pg.closed) await this.pg.close()
  }
}

export interface PGliteOptions {
  /** Persist to a directory (default: in-memory). */
  dataDir?: string
}

/** Create a PGlite instance with Ghuri's type parsers (int8 → number). */
export async function openPGlite(opts: PGliteOptions = {}): Promise<PGliteConnection> {
  const pg = new PGlite(opts.dataDir, { parsers: { [types.INT8]: (v: string) => Number(v) } })
  await pg.waitReady
  return new PGliteConnection(pg)
}

/** `DATABASES: { default: pglite() }` — one in-process database per config. */
export function pglite(opts: PGliteOptions = {}): DatabaseConfig {
  let shared: Promise<PGliteConnection> | undefined
  return {
    vendor: 'pglite',
    dialect: 'postgresql',
    options: { ...opts },
    async connect() {
      if (shared) {
        const c = await shared
        if (!c.pg.closed) return c
      }
      shared = openPGlite(opts)
      return shared
    },
  }
}
