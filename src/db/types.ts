import type { Env } from '@ghuri/core'
import type { Dialect } from '../query/sql'

export type { Dialect }
export type Vendor = 'd1' | 'postgresql' | 'sqlite' | 'pglite'

export interface ExecuteResult {
  rows: Record<string, unknown>[]
  rowsAffected?: number
  lastInsertId?: unknown
}

export interface DatabaseFeatures {
  /** Interactive transactions (BEGIN/COMMIT). False on D1. */
  supportsTransactions: boolean
  supportsSavepoints: boolean
  /** Max bound parameters per statement (D1: 100). */
  maxQueryParams: number
  /** `regex` / `iregex` lookups. */
  supportsRegex: boolean
}

/** A live database connection (one per request on Workers, per process on Node). */
export interface Connection {
  alias: string
  vendor: Vendor
  dialect: Dialect
  /** The drizzle database instance (escape hatch). */
  readonly drizzle: any
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>
  /** Run several statements atomically where the backend supports it (D1 batch, transaction elsewhere). */
  batch?(statements: Array<{ sql: string; params?: unknown[] }>): Promise<ExecuteResult[]>
  transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T>
  supportsTransactions: boolean
  features: DatabaseFeatures
  /** Execute a multi-statement script without parameters (DDL). */
  executeScript(sql: string): Promise<void>
  close(): Promise<void>
}

/** Value of `DATABASES[alias]` in settings. */
export interface DatabaseConfig {
  vendor: Vendor
  dialect: Dialect
  connect(env: Env): Promise<Connection> | Connection
  options?: Record<string, unknown>
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** `{ default: d1('DB') }`, `{ default: postgres({ url }) }`, … */
    DATABASES?: Record<string, DatabaseConfig>
  }
}
