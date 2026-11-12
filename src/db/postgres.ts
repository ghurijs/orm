import { ImproperlyConfigured } from '@ghuri/core'
import { BaseConnection } from './base'
import type { Connection, DatabaseConfig, DatabaseFeatures, ExecuteResult } from './types'

export interface PostgresOptions {
  /** `postgres://user:pass@host:5432/db` */
  url?: string
  /** Name of a Cloudflare Hyperdrive binding (`env[hyperdrive].connectionString`). */
  hyperdrive?: string
  /** Pool size (default 5; Workers typically 1–5). */
  max?: number
  /** Extra options passed to postgres.js. */
  driverOptions?: Record<string, unknown>
}

const PG_FEATURES: DatabaseFeatures = {
  supportsTransactions: true,
  supportsSavepoints: true,
  maxQueryParams: 65535,
  supportsRegex: true,
}

/** int8 → number (ids, counts). numeric stays a string (DecimalField). */
const BIGINT_AS_NUMBER = {
  to: 20,
  from: [20],
  serialize: (x: unknown) => String(x),
  parse: (x: string) => Number(x),
}

/** Connection over postgres.js (`sql` is either the pool or a transaction-scoped `sql`). */
export class PostgresJsConnection extends BaseConnection {
  readonly vendor = 'postgresql' as const
  readonly dialect = 'postgresql' as const
  readonly features = PG_FEATURES
  /** Process-wide pool (Node); per-request clients on Workers are closed at request end. */
  persistent = false

  constructor(
    readonly sql: any,
    private readonly drizzleFactory: ((client: any) => any) | undefined,
    private readonly isTransaction = false,
  ) {
    super()
  }

  /** Transactions run on a connection reserved from the pool (`sql.begin`): other queries never wait. */
  protected override get connectionWideTransactions(): boolean {
    return false
  }

  protected createDrizzle(): any {
    if (!this.drizzleFactory) throw new ImproperlyConfigured('drizzle-orm/postgres-js is not available')
    return this.drizzleFactory(this.sql)
  }

  protected async run(query: string, params: unknown[]): Promise<ExecuteResult> {
    const result = await this.sql.unsafe(query, params as any[], { prepare: params.length > 0 })
    return { rows: [...result] as Record<string, unknown>[], rowsAffected: result.count }
  }

  override async transaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    if (this.isTransaction) return fn(this)
    return this.sql.begin(async (tx: any) => {
      const child = new PostgresJsConnection(tx, this.drizzleFactory, true)
      child.alias = this.alias
      return fn(child)
    }) as Promise<T>
  }

  async executeScript(script: string): Promise<void> {
    await this.sql.unsafe(script)
  }

  async close(): Promise<void> {
    if (!this.isTransaction) await this.sql.end({ timeout: 5 })
  }
}

function isWorkersRuntime(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers'
  )
}

/**
 * PostgreSQL through postgres.js (dynamically imported so the main entry stays Workers-safe). On
 * Workers use Hyperdrive (`postgres({ hyperdrive: 'HYPERDRIVE' })`) or a TCP URL with `nodejs_compat`.
 * Workers forbid sharing I/O objects across requests, so there each request gets its own client
 * (closed when the request finishes); elsewhere (Node / VPS) one pool is shared per process.
 */
export function postgres(opts: PostgresOptions): DatabaseConfig {
  let shared: Promise<PostgresJsConnection> | undefined
  return {
    vendor: 'postgresql',
    dialect: 'postgresql',
    options: { ...opts, url: opts.url ? '<redacted>' : undefined },
    connect(env) {
      if (isWorkersRuntime()) return createPostgresConnection(opts, env)
      shared ??= createPostgresConnection(opts, env).then((c) => {
        c.persistent = true
        return c
      })
      shared.catch(() => {
        shared = undefined
      })
      return shared
    },
  }
}

async function createPostgresConnection(
  opts: PostgresOptions,
  env: Record<string, any>,
): Promise<PostgresJsConnection> {
  let url = opts.url
  if (opts.hyperdrive) {
    const hd = env?.[opts.hyperdrive] as { connectionString?: string } | undefined
    if (!hd?.connectionString)
      throw new ImproperlyConfigured(`Hyperdrive binding '${opts.hyperdrive}' not found in env.`)
    url = hd.connectionString
  }
  if (!url) throw new ImproperlyConfigured('postgres() needs `url` or `hyperdrive`.')
  // `.catch()` keeps bundlers (wrangler/esbuild) from failing when `postgres` isn't installed (D1-only
  // projects): the resolution error becomes a runtime error here instead of a build error.
  const postgresJs: any = (
    await import('postgres').catch((err) => {
      throw new ImproperlyConfigured("postgres() requires the 'postgres' package (npm install postgres).", {
        cause: err,
      })
    })
  ).default
  const drizzleMod = await import('drizzle-orm/postgres-js').catch(() => undefined)
  const drizzleFactory = drizzleMod ? (client: any) => drizzleMod.drizzle(client) : undefined
  const sql = postgresJs(url, {
    max: opts.max ?? 5,
    fetch_types: false,
    onnotice: () => {},
    types: { bigint: BIGINT_AS_NUMBER },
    ...(opts.driverOptions ?? {}),
  })
  return new PostgresJsConnection(sql, drizzleFactory)
}
