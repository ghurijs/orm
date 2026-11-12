import { describe, expect, it } from 'vitest'
import { PostgresJsConnection } from '../src/db/postgres'
import { atomic, connections, onCommit } from '../src/index'
import { backends, useTestDatabase } from './helpers'
import { Tag } from './models'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A promise plus its resolve function, to start one concurrent task once another reaches a point. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const names = async () => (await Tag.objects.all()).map((t) => t.name)

describe.each(backends)('concurrent atomic() (%s)', (backend) => {
  useTestDatabase(backend)

  it('two concurrent atomic() blocks, each awaiting inside, both succeed', async () => {
    const block = (prefix: string) =>
      atomic(async () => {
        await Tag.objects.create({ name: `${prefix}1` })
        await sleep(10)
        await Tag.objects.create({ name: `${prefix}2` })
        return prefix
      })
    expect(await Promise.all([block('a'), block('b')])).toEqual(['a', 'b'])
    expect(await names()).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('many concurrent atomic() blocks with nested savepoints all commit', async () => {
    const block = (i: number) =>
      atomic(async () => {
        await Tag.objects.create({ name: `t${i}` })
        await sleep(1)
        await atomic(async () => {
          await Tag.objects.create({ name: `t${i}-inner` })
          await sleep(1)
        })
        // A failing nested block rolls back to its savepoint without deadlocking on the outer lock.
        await expect(
          atomic(async () => {
            await Tag.objects.create({ name: `t${i}-lost` })
            throw new Error('inner')
          }),
        ).rejects.toThrow('inner')
      })
    await Promise.all(Array.from({ length: 8 }, (_, i) => block(i)))
    const all = await names()
    expect(all).toHaveLength(backend === 'd1' ? 24 : 16)
    if (backend !== 'd1') expect(all.some((n) => n.endsWith('-lost'))).toBe(false)
  })

  it.skipIf(backend === 'd1')(
    'a failure in one concurrent block rolls back only its own writes',
    async () => {
      const aStarted = signal()
      const a = atomic(async () => {
        await Tag.objects.create({ name: 'a1' })
        aStarted.resolve()
        await sleep(20)
        await Tag.objects.create({ name: 'a2' })
      })
      await aStarted.promise
      const b = atomic(async () => {
        await Tag.objects.create({ name: 'b1' })
        await sleep(5)
        throw new Error('b failed')
      })
      const [ra, rb] = await Promise.allSettled([a, b])
      expect(ra.status).toBe('fulfilled')
      expect(rb.status).toBe('rejected')
      expect((rb as PromiseRejectedResult).reason.message).toBe('b failed')
      expect(await names()).toEqual(['a1', 'a2'])
    },
  )

  it.skipIf(backend === 'd1')(
    'a failure in the first block does not roll back a concurrent one',
    async () => {
      const aStarted = signal()
      const a = atomic(async () => {
        await Tag.objects.create({ name: 'a1' })
        aStarted.resolve()
        await sleep(20)
        throw new Error('a failed')
      })
      await aStarted.promise
      const b = atomic(async () => {
        await Tag.objects.create({ name: 'b1' })
        await sleep(5)
        await Tag.objects.create({ name: 'b2' })
      })
      const [ra, rb] = await Promise.allSettled([a, b])
      expect(ra.status).toBe('rejected')
      expect(rb.status).toBe('fulfilled')
      expect(await names()).toEqual(['b1', 'b2'])
    },
  )

  it.skipIf(backend === 'd1')(
    'queries outside atomic() wait for another context’s transaction instead of joining it',
    async () => {
      const aStarted = signal()
      const a = atomic(async () => {
        await Tag.objects.create({ name: 'a1' })
        aStarted.resolve()
        await sleep(20)
        throw new Error('a failed')
      })
      await aStarted.promise
      // Autocommit write and read from another async context while `a`'s transaction is open.
      const b = (async () => {
        await Tag.objects.create({ name: 'b1' })
        return names()
      })()
      const [ra, seenByB] = await Promise.allSettled([a, b])
      expect(ra.status).toBe('rejected')
      // `b` neither saw `a`'s uncommitted row nor lost its own write to `a`'s rollback.
      expect((seenByB as PromiseFulfilledResult<string[]>).value).toEqual(['b1'])
      expect(await names()).toEqual(['b1'])
    },
  )

  it.skipIf(backend === 'd1')(
    'queries started inside atomic() (Promise.all) stay in its transaction',
    async () => {
      await expect(
        atomic(async () => {
          await Promise.all([Tag.objects.create({ name: 'p1' }), Tag.objects.create({ name: 'p2' })])
          expect(await Tag.objects.count()).toBe(2)
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(await Tag.objects.count()).toBe(0)
    },
  )

  it('onCommit callbacks run after the lock is released (they can start a new atomic block)', async () => {
    const calls: string[] = []
    await atomic(async () => {
      await Tag.objects.create({ name: 'x' })
      await onCommit(async () => {
        await atomic(async () => {
          await Tag.objects.create({ name: 'from-on-commit' })
        })
        calls.push('done')
      })
    })
    expect(calls).toEqual(['done'])
    expect(await names()).toEqual(['from-on-commit', 'x'])
  })

  it.skipIf(backend === 'd1')('concurrent connection.batch() calls are serialised too', async () => {
    const conn = await connections.get()
    const insert = (name: string) => ({ sql: 'INSERT INTO "tests_tag" ("name") VALUES (?)', params: [name] })
    const toPg = (s: { sql: string; params: unknown[] }) =>
      conn.dialect === 'postgresql' ? { ...s, sql: s.sql.replace('?', '$1') } : s
    const results = await Promise.allSettled([
      conn.batch!([insert('c1'), insert('c2')].map(toPg)),
      conn.batch!([insert('d1'), insert('c1')].map(toPg)), // unique violation: rolls back d1 only
      conn.batch!([insert('e1')].map(toPg)),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(await names()).toEqual(['c1', 'c2', 'e1'])
  })
})

describe('postgres.js connections are not serialised', () => {
  it('concurrent transactions each reserve their own connection (sql.begin) and overlap', async () => {
    let open = 0
    let maxOpen = 0
    const tx = { unsafe: async () => Object.assign([], { count: 0 }) }
    const sql = {
      unsafe: async () => Object.assign([], { count: 0 }),
      begin: async (fn: (tx: unknown) => Promise<unknown>) => {
        open++
        maxOpen = Math.max(maxOpen, open)
        try {
          return await fn(tx)
        } finally {
          open--
        }
      },
    }
    const conn = new PostgresJsConnection(sql, undefined)
    const block = () =>
      conn.transaction(async (c) => {
        await c.execute('SELECT 1')
        await sleep(10)
        return 'ok'
      })
    expect(await Promise.all([block(), block(), conn.execute('SELECT 1').then(() => 'ok')])).toEqual([
      'ok',
      'ok',
      'ok',
    ])
    expect(maxOpen).toBe(2)
  })
})
