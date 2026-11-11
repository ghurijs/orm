import { describe, expect, it } from 'vitest'
import { Avg, Coalesce, Concat, Count, F, Length, Lower, Max, Min, Q, Sum, Upper, Value } from '../src/index'
import { backends, blogFixture, useTestDatabase } from './helpers'
import { Author, Post, Tag } from './models'

describe.each(backends)('aggregates & annotations (%s)', (backend) => {
  useTestDatabase(backend)

  it('aggregate() over a queryset', async () => {
    await blogFixture()
    const r = await Post.objects.aggregate({
      n: Count('id'),
      all: Count(),
      total: Sum('views'),
      avg: Avg('views'),
      min: Min('views'),
      max: Max('views'),
      maxDate: Max('publishDate'),
      newest: Max('createdAt'),
      rating: Sum('rating'),
      avgRating: Avg('rating'),
    })
    expect(r.n).toBe(4)
    expect(r.all).toBe(4)
    expect(r.total).toBe(38)
    expect(r.avg).toBeCloseTo(9.5)
    expect(r.min).toBe(0)
    expect(r.max).toBe(25)
    expect(r.maxDate).toBe('2024-03-02')
    expect(r.newest).toBeInstanceOf(Date)
    expect(r.rating).toBe('7.75')
    expect(Number(r.avgRating)).toBeCloseTo(3.875)
    const filtered = await Post.objects.filter({ published: true }).aggregate({ total: Sum('views') })
    expect(filtered.total).toBe(35)
    const empty = await Post.objects
      .filter({ views__gt: 1000 })
      .aggregate({ total: Sum('views'), n: Count('id') })
    expect(empty).toEqual({ total: null, n: 0 })
    expect(await Post.objects.none().aggregate({ n: Count('id'), s: Sum('views') })).toEqual({
      n: 0,
      s: null,
    })
    // across relations
    const tagCount = await Post.objects.aggregate({
      tags: Count('tags'),
      distinctTags: Count('tags', { distinct: true }),
    })
    expect(tagCount.tags).toBe(4)
    expect(tagCount.distinctTags).toBe(3)
    // over a sliced / distinct queryset
    const top2 = await Post.objects
      .orderBy('-views')
      .slice(0, 2)
      .aggregate({ total: Sum('views') })
    expect(top2.total).toBe(35)
    // filtered aggregate
    const published = await Post.objects.aggregate({
      pub: Count('id', { filter: Q({ published: true }) }),
      all: Count('id'),
    })
    expect(published).toEqual({ pub: 2, all: 4 })
  })

  it('annotate() with aggregates over reverse FK and M2M (no row duplication)', async () => {
    await blogFixture()
    const authors = await Author.objects
      .annotate({ numPosts: Count('posts'), totalViews: Sum('posts__views'), numComments: Count('comments') })
      .orderBy('name')
    expect(authors.map((a: any) => [a.name, a.numPosts, a.totalViews, a.numComments])).toEqual([
      ['Ann', 2, 35, 0],
      ['Bob', 2, 3, 1],
      ['Cid', 0, null, 1],
    ])
    const posts = await Post.objects
      .annotate({ numTags: Count('tags'), numComments: Count('comments') })
      .orderBy('-numTags', 'slug')
    expect(posts.map((p: any) => [p.slug, p.numTags, p.numComments])).toEqual([
      ['hello-ghuri', 2, 2],
      ['life-notes', 1, 0],
      ['typed-orm', 1, 1],
      ['draft', 0, 0],
    ])
    // filter on annotation
    expect((await Post.objects.annotate({ n: Count('comments') }).filter({ n__gte: 1 })).length).toBe(2)
    expect(
      await Post.objects
        .annotate({ n: Count('comments') })
        .filter({ n__gte: 1 })
        .count(),
    ).toBe(2)
    // filtered count annotation
    const approved = await Post.objects
      .annotate({ ok: Count('comments', { filter: Q({ comments__approved: true }) }) })
      .get({ slug: 'hello-ghuri' })
    expect((approved as any).ok).toBe(1)
    // annotation appears in toJSON
    expect(Object.keys(approved.toJSON())).toContain('ok')
    // aggregate over an aggregate annotation (wrapped)
    const avgTags = await Post.objects
      .annotate({ n: Count('tags') })
      .aggregate({ avg: Avg('n'), max: Max('n') })
    expect(avgTags.avg).toBeCloseTo(1)
    expect(avgTags.max).toBe(2)
  })

  it('values().annotate() groups by the values fields', async () => {
    await blogFixture()
    const rows = await Post.objects
      .values('published')
      .annotate({ n: Count('id'), totalViews: Sum('views') })
      .orderBy('published')
    expect(rows).toEqual([
      { published: false, n: 2, totalViews: 3 },
      { published: true, n: 2, totalViews: 35 },
    ])
    const byAuthor = await Post.objects
      .values('author__name')
      .annotate({ n: Count('id') })
      .orderBy('author__name')
    expect(byAuthor).toEqual([
      { author__name: 'Ann', n: 2 },
      { author__name: 'Bob', n: 2 },
    ])
    const tagsPerAuthor = await Post.objects
      .values('author')
      .annotate({ numTags: Count('tags') })
      .filter({ numTags__gt: 1 })
    expect(tagsPerAuthor.length).toBe(1)
    expect(tagsPerAuthor[0].numTags).toBe(3)
    expect(
      await Post.objects
        .values('author')
        .annotate({ n: Count('id') })
        .count(),
    ).toBe(2)
    const list = await Tag.objects
      .annotate({ n: Count('posts') })
      .orderBy('-n', 'name')
      .valuesList('name', 'n')
    expect(list).toEqual([
      ['ts', 2],
      ['fun', 1],
      ['js', 1],
    ])
  })

  it('expressions: F arithmetic, Value, functions', async () => {
    await blogFixture()
    const p = (await Post.objects
      .annotate({
        score: F('views').mul(2).add(1),
        lower: Lower('title'),
        upper: Upper('slug'),
        len: Length('title'),
        label: Concat('title', Value(' by '), 'author__name'),
        cat: Coalesce('category__name', Value('none')),
        flag: Value(true),
      })
      .get({ slug: 'draft' })) as any
    expect(p.score).toBe(1)
    expect(p.lower).toBe('draft')
    expect(p.upper).toBe('DRAFT')
    expect(p.len).toBe(5)
    expect(p.label).toBe('Draft by Bob')
    expect(p.cat).toBe('none')
    expect(p.flag).toBe(true)
    const ordered = await Post.objects
      .annotate({ s: F('views').mul(-1) })
      .orderBy('s')
      .valuesList('slug', { flat: true })
    expect(ordered[0]).toBe('typed-orm')
  })
})
