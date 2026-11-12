// @ghuri/orm/sqlite — SQLite through better-sqlite3 (Node only).
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { BaseConnection } from './db/base'
import type { DatabaseConfig, DatabaseFeatures, ExecuteResult } from './db/types'

type Statement = ReturnType<Database.Database['prepare']>

const MAX_CACHED_STATEMENTS = 200

function regexp(pattern: string, value: unknown): number {
  if (value === null || value === undefined) return 0
  let flags = ''
  let p = String(pattern)
  if (p.startsWith('(?i)')) {
    flags = 'i'
    p = p.slice(4)
  }
  return new RegExp(p, flags).test(String(value)) ? 1 : 0
}

export class SqliteConnection extends BaseConnection {
  readonly vendor = 'sqlite' as const
  readonly dialect = 'sqlite' as const
  readonly features: DatabaseFeatures = {
    supportsTransactions: true,
    supportsSavepoints: true,
    maxQueryParams: 32766,
    supportsRegex: true,
  }
  /** Shared by every context in the process; never closed at request end. */
  readonly persistent = true
  private statements = new Map<string, Statement>()

  constructor(readonly db: Database.Database) {
    super()
  }

  protected createDrizzle(): any {
    return drizzle(this.db)
  }

  protected override normalizeParams(params: unknown[]): unknown[] {
    return super
      .normalizeParams(params)
      .map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p))
  }

  private prepare(sql: string): Statement {
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      if (this.statements.size >= MAX_CACHED_STATEMENTS) {
        const first = this.statements.keys().next().value
        if (first !== undefined) this.statements.delete(first)
      }
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  protected async run(sql: string, params: unknown[]): Promise<ExecuteResult> {
    const stmt = this.prepare(sql)
    if (stmt.reader) {
      const rows = (stmt.all as (...a: unknown[]) => unknown[])(...params) as Record<string, unknown>[]
      for (const r of rows)
        for (const k in r) if (Buffer.isBuffer(r[k])) r[k] = new Uint8Array(r[k] as Buffer)
      return { rows, rowsAffected: rows.length }
    }
    const info = (stmt.run as (...a: unknown[]) => Database.RunResult)(...params)
    return { rows: [], rowsAffected: info.changes, lastInsertId: Number(info.lastInsertRowid) }
  }

  async executeScript(sql: string): Promise<void> {
    await this.serialized(async () => {
      this.db.exec(sql)
    })
  }

  async close(): Promise<void> {
    this.statements.clear()
    if (this.db.open) this.db.close()
  }
}

export interface SqliteOptions {
  /** Path of the database file, or ':memory:'. */
  filename: string
  /** Extra better-sqlite3 options. */
  options?: Database.Options
  /** Use WAL journal mode for file databases (default true). */
  wal?: boolean
}

/** Open a better-sqlite3 database with the settings Ghuri expects (foreign keys on, REGEXP). */
export function openSqlite(opts: SqliteOptions): SqliteConnection {
  const db = new Database(opts.filename, opts.options)
  db.pragma('foreign_keys = ON')
  if (opts.filename !== ':memory:' && opts.filename !== '' && opts.wal !== false)
    db.pragma('journal_mode = WAL')
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) =>
    regexp(String(pattern), value),
  )
  return new SqliteConnection(db)
}

/** `DATABASES: { default: sqlite({ filename: 'db.sqlite3' }) }` — one connection per process. */
export function sqlite(opts: SqliteOptions): DatabaseConfig {
  let shared: SqliteConnection | undefined
  return {
    vendor: 'sqlite',
    dialect: 'sqlite',
    options: { filename: opts.filename },
    connect() {
      if (!shared?.db.open) shared = openSqlite(opts)
      return shared
    },
  }
}
