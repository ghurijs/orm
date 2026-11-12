// pglite({ dataDir }) on disk: the directory (and its parents) are created on first connect.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pglite } from '../src/pglite'

const root = mkdtempSync(join(tmpdir(), 'ghuri-pglite-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('pglite() with a data directory', () => {
  it('creates missing parent directories and persists data', async () => {
    const dataDir = join(root, 'nested', 'pgdata')
    const conn = await pglite({ dataDir }).connect({})
    await conn.execute('CREATE TABLE t (id int)')
    await conn.execute('INSERT INTO t VALUES (1)')
    await conn.close()
    expect(existsSync(dataDir)).toBe(true)
    const again = await pglite({ dataDir }).connect({})
    expect((await again.execute('SELECT count(*)::int AS n FROM t')).rows).toEqual([{ n: 1 }])
    await again.close()
  })
})
