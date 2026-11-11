import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ["src/index.ts","src/migrations.ts","src/sqlite.ts","src/pglite.ts","src/testing.ts","src/commands.ts"],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // keep `node:async_hooks` (Workers nodejs_compat needs the prefix)
  removeNodeProtocol: false,
  external: [/^@ghuri\//, /^node:/, /^drizzle-orm/, 'cloudflare:workers', 'better-sqlite3', '@electric-sql/pglite', 'postgres', 'miniflare'],
})
