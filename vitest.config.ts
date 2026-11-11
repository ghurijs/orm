import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Migration files written by tests import '@ghuri/orm/migrations': use the sources, not dist.
    alias: [
      { find: /^@ghuri\/orm\/migrations$/, replacement: fileURLToPath(new URL('./src/migrations.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // DB backends (PGlite, Miniflare) start slowly on busy machines.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
