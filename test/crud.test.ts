import { describe, expect, it } from 'vitest'
import { atomic, captureQueries, F, IntegrityError, Q } from '../src/index'
import { backends, blogFixture, titles, useTestDatabase } from './helpers'
import { Author, Category, Post, Tag } from './models'

describe.each(backends)('CRUD (%s)', (backend) => {
  useTestDatabase(backend)

  it('create / save / refreshFromDb / delete', async () => {
    const a = new Author({ name: 'Ann' })
    expect(a.pk).toBeNull()
    expect(a._state.adding).toBe(true)
    await a.save()
    expect(a.id).toBeGreaterThan(0)
    expect(a._state.adding).toBe(false)
    a.name = 'Annie'
    await a.save()
    const fresh = await Author.objects.get({ pk: a.pk })
    expect(fresh.name).toBe('Annie')
    expect(fresh.isActive).toBe(true)
    await Author.objects.filter({ pk: a.pk }).update({ name: 'Changed' })
    await a.refreshFromDb()
    expect(a.name).toBe('Changed')
    const [n, per] = await a.delete()
    expect(n).toBe(1)
    expect(per['tests.Author']).toBe(1)
    expect(a.pk).toBeNull()
    expect(await Author.objects.count()).toBe(0)
  })

  it('save({ updateFields }) only writes those columns', async () => {
    const a = await Author.objects.create({ name: 'Ann', age: 1 })
    const copy = await Author.objects.get({ pk: a.pk })
    copy.age = 99
    await copy.save()
    a.name = 'Renamed'
    a.age = 5
    await a.save({ updateFields: ['name'] })
    const fresh = await Author.objects.get({ pk: a.pk })
    expect(fresh.name).toBe('Renamed')
    expect(fresh.age).toBe(99)
  })

  it('autoNow / autoNowAdd and defaults', async () => {
    const { ann } = await blogFixture()
    const p = await Post.objects.create({ title: 'T', slug: 't', author: ann })
    expect(p.createdAt).toBeInstanceOf(Date)
    expect(p.status).toBe('draft')
    expect(p.views).toBe(0)
    expect(p.metadata).toEqual({})
    const created = p.createdAt.getTime()
    await new Promise((r) => setTimeout(r, 5))
    p.title = 'T2'
    await p.save()
    const fresh = await Post.objects.get({ pk: p.pk })
    expect(fresh.createdAt.getTime()).toBe(created)
    expect(fresh.updatedAt.getTime()).toBeGreaterThanOrEqual(created)
  })

  it('get() errors', async () => {
    await blogFixture()
    await expect(Author.objects.get({ name: 'Nobody' })).rejects.toBeInstanceOf(Author.DoesNotExist)
    await expect(Author.objects.get({ name: 'Nobody' })).rejects.toThrow(
      'Author matching query does not exist.',
    )
    await expect(Post.objects.get({ published: true })).rejects.toBeInstanceOf(Post.MultipleObjectsReturned)
    const { ObjectDoesNotExist } = await import('@ghuri/core')
    await expect(Author.objects.get({ name: 'Nobody' })).rejects.toBeInstanceOf(ObjectDoesNotExist)
  })

  it('first / last / latest / earliest / exists / count', async () => {
    await blogFixture()
    expect((await Author.objects.first())?.name).toBe('Ann')
    expect((await Author.objects.last())?.name).toBe('Cid')
    expect((await Author.objects.orderBy('-age').first())?.name).toBe('Bob')
    expect(await Author.objects.filter({ name: 'Zed' }).first()).toBeNull()
    expect((await Post.objects.latest('views')).title).toBe('Typed ORM')
    expect((await Post.objects.earliest('views')).title).toBe('Draft')
    expect(await Post.objects.filter({ published: true }).exists()).toBe(true)
    expect(await Post.objects.filter({ title: 'nope' }).exists()).toBe(false)
    expect(await Post.objects.count()).toBe(4)
    expect(await Post.objects.none().count()).toBe(0)
    expect(await Post.objects.none()).toEqual([])
  })

  it('ordering, reverse, slicing and default Meta.ordering', async () => {
    await blogFixture()
    const names = (await Author.objects.all()).map((a) => a.name)
    expect(names).toEqual(['Ann', 'Bob', 'Cid'])
    expect((await Author.objects.orderBy('-name')).map((a) => a.name)).toEqual(['Cid', 'Bob', 'Ann'])
    expect((await Author.objects.all().reverse()).map((a) => a.name)).toEqual(['Cid', 'Bob', 'Ann'])
    expect((await Post.objects.orderBy('views').slice(1, 3)).map((p) => p.views)).toEqual([3, 10])
    expect((await Post.objects.orderBy('views').slice(2)).map((p) => p.views)).toEqual([10, 25])
    expect((await Post.objects.orderBy('views').slice(1, 3).slice(1)).map((p) => p.views)).toEqual([10])
    expect((await Post.objects.orderBy('author__name', '-views')).map((p) => p.views)).toEqual([25, 10, 3, 0])
    expect((await Post.objects.orderBy(F('rating').desc({ nullsLast: true }))).map((p) => p.rating)).toEqual([
      '4.50',
      '3.25',
      null,
      null,
    ])
    expect(() => Post.objects.all().slice(0, 1).filter({ views: 1 })).toThrow(/slice/)
    expect(await Post.objects.orderBy('?').count()).toBe(4)
  })

  it('thenable, async iteration and iterator()', async () => {
    await blogFixture()
    const qs = Author.objects.all()
    const seen: string[] = []
    for await (const a of qs) seen.push(a.name)
    expect(seen).toEqual(['Ann', 'Bob', 'Cid'])
    const viaThen = await qs
    expect(viaThen.length).toBe(3)
    const chunked: string[] = []
    for await (const a of Author.objects.orderBy('name').iterator(2)) chunked.push(a.name)
    expect(chunked).toEqual(['Ann', 'Bob', 'Cid'])
    // results are cached on the queryset
    const [, queries] = await captureQueries(async () => {
      await qs
      await qs.count()
    })
    expect(queries.length).toBe(0)
  })

  it('values / valuesList', async () => {
    await blogFixture()
    const rows = await Post.objects.orderBy('views').values('title', 'author__name', 'published')
    expect(rows[0]).toEqual({ title: 'Draft', author__name: 'Bob', published: false })
    const all = await Author.objects.filter({ name: 'Ann' }).values()
    expect(Object.keys(all[0]).sort()).toEqual(['age', 'bio', 'email', 'id', 'isActive', 'name'])
    expect(await Author.objects.valuesList('name', { flat: true })).toEqual(['Ann', 'Bob', 'Cid'])
    expect(await Author.objects.orderBy('name').valuesList('name', 'age')).toEqual([
      ['Ann', 30],
      ['Bob', 40],
      ['Cid', null],
    ])
    const fk = await Post.objects.filter({ slug: 'draft' }).values('author', 'authorId')
    expect(fk[0].author).toBe(fk[0].authorId)
    expect(
      await Post.objects.filter({ slug: 'draft' }).valuesList('publishDate__year', { flat: true }),
    ).toEqual([null])
    expect(
      await Post.objects.filter({ slug: 'hello-ghuri' }).valuesList('publishDate__year', { flat: true }),
    ).toEqual([2024])
    expect(await Post.objects.orderBy('views').valuesList('views', { flat: true }).get({ views: 3 })).toBe(3)
  })

  it('only / defer', async () => {
    await blogFixture()
    const p = await Post.objects.only('title').get({ slug: 'hello-ghuri' })
    expect(p.title).toBe('Hello Ghuri')
    expect(p.body).toBeUndefined()
    expect(p._state.deferred.has('body')).toBe(true)
    p.title = 'Changed'
    await p.save()
    const fresh = await Post.objects.get({ slug: 'hello-ghuri' })
    expect(fresh.title).toBe('Changed')
    expect(fresh.body).toBe('First post about Ghuri')
    const d = await Post.objects.defer('body', 'metadata').get({ slug: 'typed-orm' })
    expect(d.body).toBeUndefined()
    expect(d.views).toBe(25)
    await d.refreshFromDb({ fields: ['body'] })
    expect(d.body).toBe('TypeScript all the way')
  })

  it('distinct', async () => {
    await blogFixture()
    const authors = await Author.objects.filter({ posts__published: true }).distinct()
    expect(authors.map((a) => a.name)).toEqual(['Ann'])
    expect(await Post.objects.values('author').distinct().count()).toBe(2)
  })

  it('update() with F expressions and Q', async () => {
    await blogFixture()
    const n = await Post.objects.filter({ published: true }).update({ views: F('views').add(1) })
    expect(n).toBe(2)
    expect((await Post.objects.get({ slug: 'typed-orm' })).views).toBe(26)
    await Post.objects
      .filter(Q({ slug: 'draft' }).or({ slug: 'life-notes' }))
      .update({ views: F('views').mul(2).add(F('views')) })
    expect((await Post.objects.get({ slug: 'life-notes' })).views).toBe(9)
    expect(await Post.objects.filter({ author__name: 'Bob' }).update({ published: true })).toBe(2)
    expect(await Post.objects.filter({ published: false }).count()).toBe(0)
    expect(await Post.objects.filter({ views__gt: F('rating') }).count()).toBeGreaterThan(0)
  })

  it('getOrCreate / updateOrCreate', async () => {
    const [a, created] = await Author.objects.getOrCreate({ name: 'Ann' }, { defaults: { age: 33 } })
    expect(created).toBe(true)
    expect(a.age).toBe(33)
    const [b, created2] = await Author.objects.getOrCreate({ name: 'Ann' }, { defaults: { age: 99 } })
    expect(created2).toBe(false)
    expect(b.pk).toBe(a.pk)
    const [c, created3] = await Author.objects.updateOrCreate({ name: 'Ann' }, { defaults: { age: 50 } })
    expect(created3).toBe(false)
    expect(c.age).toBe(50)
    expect((await Author.objects.get({ name: 'Ann' })).age).toBe(50)
    const [d, created4] = await Author.objects.updateOrCreate(
      { name: 'Bob' },
      { defaults: { age: 1 }, createDefaults: { age: 2 } },
    )
    expect(created4).toBe(true)
    expect(d.age).toBe(2)
  })

  it('bulkCreate / bulkUpdate / inBulk', async () => {
    const tags = await Tag.objects.bulkCreate(
      Array.from({ length: 120 }, (_, i) => new Tag({ name: `t${i}` })),
    )
    expect(tags.every((t) => typeof t.id === 'number')).toBe(true)
    expect(new Set(tags.map((t) => t.id)).size).toBe(120)
    expect(await Tag.objects.count()).toBe(120)
    const bulk = await Tag.objects.inBulk([tags[0].id, tags[5].id])
    expect(bulk.get(tags[5].id)?.name).toBe('t5')
    expect(bulk.size).toBe(2)
    const byName = await Tag.objects.inBulk(['t1', 't2'], { fieldName: 'name' })
    expect([...byName.keys()].sort()).toEqual(['t1', 't2'])
    tags[0].name = 'zero'
    tags[1].name = 'one'
    expect(await Tag.objects.bulkUpdate([tags[0], tags[1]], ['name'])).toBe(2)
    expect(await Tag.objects.filter({ name__in: ['zero', 'one'] }).count()).toBe(2)
    // large IN lists (> D1's 100 bound parameters)
    expect(await Tag.objects.filter({ id__in: tags.map((t) => t.id) }).count()).toBe(120)
    const ignored = await Tag.objects.bulkCreate([new Tag({ name: 'zero' }), new Tag({ name: 'fresh' })], {
      ignoreConflicts: true,
    })
    expect(ignored.length).toBe(2)
    expect(await Tag.objects.count()).toBe(121)
  })

  it('custom managers and default manager', async () => {
    await blogFixture()
    expect(await Post.published.count()).toBe(2)
    expect((await Post.published.filter({ views__gt: 15 })).map((p) => p.title)).toEqual(['Typed ORM'])
    expect(Post._defaultManager).toBe(Post.objects)
    expect(Post.published.model).toBe(Post)
  })

  it('toJSON and fromRow', async () => {
    const { p1 } = await blogFixture()
    const json = p1.toJSON()
    expect(json.title).toBe('Hello Ghuri')
    expect(json.authorId).toBe(p1.authorId)
    expect(JSON.parse(JSON.stringify(p1)).createdAt).toBe(p1.createdAt.toISOString())
    const fromRow = Category.fromRow({ id: 5, name: 'X', parent_id: null })
    expect(fromRow.name).toBe('X')
    expect(fromRow.parentId).toBeNull()
    expect(fromRow._state.adding).toBe(false)
  })

  it('IntegrityError on unique violation', async () => {
    await Tag.objects.create({ name: 'dup' })
    await expect(Tag.objects.create({ name: 'dup' })).rejects.toBeInstanceOf(IntegrityError)
  })

  it.skipIf(backend === 'd1')('atomic() rolls back and supports nested savepoints', async () => {
    await expect(
      atomic(async () => {
        await Tag.objects.create({ name: 'a' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await Tag.objects.count()).toBe(0)
    await atomic(async () => {
      await Tag.objects.create({ name: 'outer' })
      await expect(
        atomic(async () => {
          await Tag.objects.create({ name: 'inner' })
          throw new Error('inner boom')
        }),
      ).rejects.toThrow('inner boom')
      await Tag.objects.create({ name: 'outer2' })
    })
    expect((await Tag.objects.all()).map((t) => t.name)).toEqual(['outer', 'outer2'])
    // integrity error inside a nested block doesn't poison the outer transaction
    await atomic(async () => {
      await expect(atomic(() => Tag.objects.create({ name: 'outer' }))).rejects.toBeInstanceOf(IntegrityError)
      await Tag.objects.create({ name: 'after' })
    })
    expect(await Tag.objects.filter({ name: 'after' }).exists()).toBe(true)
  })

  it.runIf(backend === 'd1')('atomic() is best effort on D1 (no rollback)', async () => {
    await expect(
      atomic(async () => {
        await Tag.objects.create({ name: 'kept' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await Tag.objects.count()).toBe(1)
  })

  it('onCommit runs after the outermost block', async () => {
    const { onCommit } = await import('../src/index')
    const calls: string[] = []
    await atomic(async () => {
      await onCommit(() => {
        calls.push('committed')
      })
      calls.push('body')
    })
    expect(calls).toEqual(['body', 'committed'])
  })

  it('titles helper sanity', async () => {
    await blogFixture()
    expect(titles(await Post.objects.all())).toEqual(['Draft', 'Hello Ghuri', 'Life notes', 'Typed ORM'])
  })
})
