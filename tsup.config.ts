import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ["src/index.ts","src/migrations.ts","src/sqlite.ts","src/pglite.ts","src/testing.ts","src/commands.ts"],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: [/^@ghuri\//, /^node:/, 'cloudflare:workers'],
})
