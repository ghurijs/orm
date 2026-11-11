import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferIO, callCommand } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerOrmCommands } from '../src/commands'
import { copyData, dumpData, type FixtureObject, flushDatabase, loadData } from '../src/migrations'
import { setupTestDatabase, type TestDatabase, testBackends } from '../src/testing'
import { blogFixture } from './helpers'
import { Author, allModels, Comment, Post, Sample, Tag } from './models'

registerOrmCommands()
const dir = mkdtempSync(join(tmpdir(), 'ghuri-data-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function sampleRow() {
  return Sample.objects.create({
    char: 'c',
    text: 'long text',
    int: 3,
    big: 9007199254740,
    positive: 4,
    float: 1.5,
    dec: '12.345',
    flag: true,
    day: '2024-02-29',
    at: new Date('2024-05-06T07:08:09.123Z'),
    time: '10:11:12',
    dur: 3600000,
    data: { a: [1, 'x'], b: null, s: '123' },
    blob: new Uint8Array([0, 1, 254, 255]),
    uuid: '6f1c2b2e-6d3c-4b8a-9a55-0f6a4c1d2e3f',
    ip: '10.0.0.1',
  })
}

describe.each(testBackends())('dumpdata / loaddata (%s)', (backend) => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await setupTestDatabase({ using: backend, models: allModels })
  })
  afterAll(async () => {
    await db?.teardown()
  })

  it('round-trips every row, M2M and value type', async () => {
    const f = await blogFixture()
    await sampleRow()
    const objects = await dumpData()
    const post = objects.find((o) => o.model === 'tests.post' && o.pk === f.p1.pk)!
    expect(post.fields).toMatchObject({
      title: 'Hello Ghuri',
      author: f.ann.pk,
      category: f.js.pk,
      published: true,
      tags: [f.tagJs.pk, f.tagTs.pk],
      metadata: {},
    })
    expect(typeof post.fields.createdAt).toBe('string')
    expect(objects.some((o) => o.model.includes('post_tags'))).toBe(false)
    const sample = objects.find((o) => o.model === 'tests.sample')!
    expect(sample.fields).toMatchObject({
      blob: 'AAH+/w==',
      at: '2024-05-06T07:08:09.123Z',
      data: { s: '123' },
    })
    // models come after the models they reference
    const order = [...new Set(objects.map((o) => o.model))]
    expect(order.indexOf('tests.author')).toBeLessThan(order.indexOf('tests.post'))
    expect(order.indexOf('tests.post')).toBeLessThan(order.indexOf('tests.comment'))

    const flushed = await flushDatabase({ inhibitPostMigrate: true })
    expect(flushed).toContain('tests_post_tags')
    expect(await Post.objects.count()).toBe(0)

    const res = await loadData(objects)
    expect(res.objects).toBe(objects.length)
    expect(await dumpData()).toEqual(objects)
    const p1 = await Post.objects.get({ pk: f.p1.pk })
    expect((await p1.tags.all()).map((t) => t.name).sort()).toEqual(['js', 'ts'])
    expect((await Sample.objects.get({})).blob).toEqual(new Uint8Array([0, 1, 254, 255]))

    // loading again updates in place (no duplicates); sequences continue after the loaded ids
    await loadData(objects)
    expect(await Author.objects.count()).toBe(3)
    const next = await Author.objects.create({ name: 'New' })
    expect(next.pk).toBeGreaterThan(f.cid.pk)
    const t = await Tag.objects.create({ name: 'new' })
    expect(t.pk).toBeGreaterThan(f.tagFun.pk)
  })

  it('dumpdata / loaddata / flush commands', async () => {
    await db.flush()
    await blogFixture()
    const out = join(dir, `dump-${backend}.json`)
    const io = bufferIO()
    await callCommand(
      'dumpdata',
      { app_label: ['tests.Author', 'tests.Post', 'tests.Tag', 'tests.Category'], indent: 2, output: out },
      io,
    )
    const saved = JSON.parse(readFileSync(out, 'utf8')) as FixtureObject[]
    expect(new Set(saved.map((o) => o.model))).toEqual(
      new Set(['tests.author', 'tests.post', 'tests.tag', 'tests.category']),
    )
    expect(readFileSync(out, 'utf8')).toContain('\n  {\n    "model"')

    const excluded = bufferIO()
    await callCommand('dumpdata', { exclude: ['tests.Comment', 'tests.Sample'] }, excluded)
    const all = JSON.parse(excluded.out[0]) as FixtureObject[]
    expect(all.some((o) => o.model === 'tests.comment')).toBe(false)
    expect(all.some((o) => o.model === 'tests.post')).toBe(true)

    await expect(callCommand('flush', {}, bufferIO())).rejects.toThrow(/--no-input/)
    const fio = bufferIO()
    await callCommand('flush', { noInput: true }, fio)
    expect(fio.out[0]).toMatch(/^Flushed \d+ table\(s\) in 'default'\.$/)
    expect(await Author.objects.count()).toBe(0)

    const lio = bufferIO()
    await callCommand('loaddata', { fixture: [out] }, lio)
    expect(lio.out).toEqual([`Installed ${saved.length} object(s) from 1 fixture(s)`])
    expect(await Post.objects.count()).toBe(4)
    expect(await Comment.objects.count()).toBe(0)
    await db.flush()
  })
})

describe.each([
  ['sqlite', 'pglite'],
  ['d1', 'pglite'],
] as const)('copydata %s → %s (D1 → Postgres move)', (source, target) => {
  let src: TestDatabase
  let dst: TestDatabase
  beforeAll(async () => {
    src = await setupTestDatabase({ using: source, models: allModels })
    dst = await setupTestDatabase({ using: target, alias: 'pg', models: allModels })
  })
  afterAll(async () => {
    await dst?.teardown()
    await src?.teardown()
  })

  it('copies every row and keeps relations, then the target keeps working', async () => {
    const f = await blogFixture()
    await sampleRow()
    const io = bufferIO()
    await callCommand('copydata', { from: 'default', to: 'pg' }, io)
    expect(io.out[0]).toMatch(/^Copied \d+ object\(s\) of \d+ model\(s\) from 'default' to 'pg'\.$/)
    const a = await dumpData({ using: 'default' })
    const b = await dumpData({ using: 'pg' })
    expect(b).toEqual(a)
    const posts = await Post.objects.using('pg').filter({ tags__name: 'ts' }).orderBy('title')
    expect(posts.map((p) => p.title)).toEqual(['Hello Ghuri', 'Typed ORM'])
    const created = await Author.objects.using('pg').create({ name: 'After move' })
    expect(created.pk).toBeGreaterThan(f.cid.pk)
    // copying again with --flush replaces the data
    await copyData({ from: 'default', to: 'pg', flush: true })
    expect(await Author.objects.using('pg').count()).toBe(3)
  })
})
