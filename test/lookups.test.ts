import { describe, expect, it } from 'vitest'
import { F, FieldError, NotSupportedError, Q } from '../src/index'
import { backends, blogFixture, titles, useTestDatabase } from './helpers'
import { Author, Category, Post, Sample, Tag } from './models'

describe.each(backends)('lookups (%s)', (backend) => {
  useTestDatabase(backend)

  it('exact / iexact / isnull / in / range / comparisons', async () => {
    await blogFixture()
    expect(titles(await Post.objects.filter({ title: 'Draft' }))).toEqual(['Draft'])
    expect(titles(await Post.objects.filter({ title__exact: 'Draft' }))).toEqual(['Draft'])
    expect(titles(await Post.objects.filter({ title__iexact: 'hello GHURI' }))).toEqual(['Hello Ghuri'])
    expect((await Author.objects.filter({ email: null })).map((a) => a.name)).toEqual(['Cid'])
    expect((await Author.objects.filter({ email__isnull: true })).map((a) => a.name)).toEqual(['Cid'])
    expect((await Author.objects.filter({ email__isnull: false })).map((a) => a.name)).toEqual(['Ann', 'Bob'])
    expect(titles(await Post.objects.filter({ views__in: [3, 25, 999] }))).toEqual(['Life notes', 'Typed ORM'])
    expect(await Post.objects.filter({ views__in: [] }).count()).toBe(0)
    expect(titles(await Post.objects.filter({ views__range: [3, 10] }))).toEqual(['Hello Ghuri', 'Life notes'])
    expect(titles(await Post.objects.filter({ views__gt: 10 }))).toEqual(['Typed ORM'])
    expect(titles(await Post.objects.filter({ views__gte: 10 }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ views__lt: 3 }))).toEqual(['Draft'])
    expect(titles(await Post.objects.filter({ views__lte: 3 }))).toEqual(['Draft', 'Life notes'])
    expect(titles(await Post.objects.filter({ rating__gt: '4' }))).toEqual(['Hello Ghuri'])
    expect(titles(await Post.objects.filter({ published: true }))).toEqual(['Hello Ghuri', 'Typed ORM'])
  })

  it('contains / icontains / startswith / endswith (case rules are portable)', async () => {
    await blogFixture()
    expect(titles(await Post.objects.filter({ title__contains: 'Ghuri' }))).toEqual(['Hello Ghuri'])
    expect(await Post.objects.filter({ title__contains: 'ghuri' }).count()).toBe(0)
    expect(titles(await Post.objects.filter({ title__icontains: 'ghuri' }))).toEqual(['Hello Ghuri'])
    expect(titles(await Post.objects.filter({ title__startswith: 'Typed' }))).toEqual(['Typed ORM'])
    expect(await Post.objects.filter({ title__startswith: 'typed' }).count()).toBe(0)
    expect(titles(await Post.objects.filter({ title__istartswith: 'typed' }))).toEqual(['Typed ORM'])
    expect(titles(await Post.objects.filter({ title__endswith: 'notes' }))).toEqual(['Life notes'])
    expect(titles(await Post.objects.filter({ title__iendswith: 'NOTES' }))).toEqual(['Life notes'])
    // wildcard characters are escaped
    expect(titles(await Post.objects.filter({ body__contains: '100%' }))).toEqual(['Life notes'])
    expect(titles(await Post.objects.filter({ body__icontains: 'fun_' }))).toEqual(['Life notes'])
    expect(await Post.objects.filter({ body__contains: '%' }).count()).toBe(1)
    expect(await Post.objects.filter({ body__contains: '*' }).count()).toBe(0)
    expect(await Post.objects.filter({ title__contains: F('slug') }).count()).toBe(0)
  })

  it('date / year / month / day transforms on DateField and DateTimeField', async () => {
    await blogFixture()
    expect(titles(await Post.objects.filter({ publishDate__year: 2024 }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ publishDate__year__lt: 2024 }))).toEqual(['Life notes'])
    expect(titles(await Post.objects.filter({ publishDate__month: 3 }))).toEqual(['Typed ORM'])
    expect(titles(await Post.objects.filter({ publishDate__day: 31 }))).toEqual(['Life notes'])
    expect(titles(await Post.objects.filter({ publishDate__gte: '2024-01-01' }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ publishDate: new Date('2024-01-15T00:00:00Z') }))).toEqual(['Hello Ghuri'])
    await Sample.objects.create({ at: new Date('2023-06-30T23:30:00.000Z') })
    await Sample.objects.create({ at: new Date('2024-07-01T10:00:00.000Z') })
    expect(await Sample.objects.filter({ at__year: 2023 }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__month: 7 }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__day: 30 }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__hour: 23 }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__date: '2023-06-30' }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__date__gt: '2023-06-30' }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__gt: new Date('2024-01-01T00:00:00Z') }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__lt: '2024-01-01T00:00:00Z' }).count()).toBe(1)
    expect(await Sample.objects.filter({ at__range: [new Date('2023-01-01'), new Date('2025-01-01')] }).count()).toBe(2)
    expect(await Sample.objects.filter({ at__week_day: 6 }).count()).toBe(1) // 2023-06-30 is a Friday (Sunday = 1)
    expect(await Sample.objects.filter({ at__quarter: 3 }).count()).toBe(1)
  })

  it.skipIf(backend === 'd1')('regex / iregex', async () => {
    await blogFixture()
    expect(titles(await Post.objects.filter({ title__regex: '^H.*i$' }))).toEqual(['Hello Ghuri'])
    expect(titles(await Post.objects.filter({ title__iregex: '^h.*I$' }))).toEqual(['Hello Ghuri'])
  })

  it.runIf(backend === 'd1')('regex raises NotSupportedError on D1', async () => {
    await expect(Post.objects.filter({ title__regex: '^H' }).count()).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('Q objects: and / or / not, exclude, null-safe negation', async () => {
    await blogFixture()
    expect(titles(await Post.objects.filter(Q({ views: 3 }).or(Q({ views: 25 }))))).toEqual(['Life notes', 'Typed ORM'])
    expect(titles(await Post.objects.filter(Q({ published: true }).and(Q.not({ title__startswith: 'Typed' }))))).toEqual(['Hello Ghuri'])
    expect(titles(await Post.objects.filter(Q.or({ views: 0 }, { views: 3 }), { author__name: 'Bob' }))).toEqual(['Draft', 'Life notes'])
    expect(titles(await Post.objects.exclude({ published: true }))).toEqual(['Draft', 'Life notes'])
    expect(titles(await Post.objects.exclude({ published: true, views: 3 }))).toEqual(['Draft', 'Hello Ghuri', 'Life notes', 'Typed ORM'])
    expect(titles(await Post.objects.exclude({ published: true, views: 10 }))).toEqual(['Draft', 'Life notes', 'Typed ORM'])
    // Django: exclude() includes rows where the column is NULL
    expect((await Author.objects.exclude({ email: 'ann@example.com' })).map((a) => a.name)).toEqual(['Bob', 'Cid'])
    expect((await Author.objects.exclude({ age__gt: 35 })).map((a) => a.name)).toEqual(['Ann', 'Cid'])
    expect(titles(await Post.objects.filter(Q.not(Q({ category__name: 'Tech' }))))).toEqual(['Draft', 'Hello Ghuri', 'Life notes'])
    expect(await Post.objects.filter(Q()).count()).toBe(4)
  })

  it('F expressions compare columns and do arithmetic', async () => {
    await blogFixture()
    await Author.objects.filter({ name: 'Ann' }).update({ age: 10 })
    expect(titles(await Post.objects.filter({ views__gt: F('author__age') }))).toEqual(['Typed ORM'])
    expect(titles(await Post.objects.filter({ views: F('views').mul(2).sub(F('views')) }))).toHaveLength(4)
    expect((await Post.objects.annotate({ double: F('views').mul(2) }).get({ slug: 'typed-orm' }) as any).double).toBe(50)
  })

  it('spans forward FK, reverse FK, M2M and reverse M2M', async () => {
    const f = await blogFixture()
    expect(titles(await Post.objects.filter({ author__name: 'Ann' }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ author: f.ann }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ author: f.ann.id }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ authorId: f.bob.id }))).toEqual(['Draft', 'Life notes'])
    expect(titles(await Post.objects.filter({ author__in: [f.bob] }))).toEqual(['Draft', 'Life notes'])
    expect(titles(await Post.objects.filter({ category__parent__name: 'Tech' }))).toEqual(['Hello Ghuri'])
    expect(titles(await Post.objects.filter({ category__isnull: true }))).toEqual(['Draft'])
    // reverse FK
    expect((await Author.objects.filter({ posts__views__gte: 25 })).map((a) => a.name)).toEqual(['Ann'])
    expect((await Author.objects.filter({ posts__isnull: true })).map((a) => a.name)).toEqual(['Cid'])
    expect((await Author.objects.filter({ posts__isnull: false })).map((a) => a.name)).toEqual(['Ann', 'Bob'])
    expect((await Author.objects.filter({ comments__text: 'Nice' })).map((a) => a.name)).toEqual(['Bob'])
    expect((await Author.objects.filter({ posts: f.p3 })).map((a) => a.name)).toEqual(['Bob'])
    // M2M
    expect(titles(await Post.objects.filter({ tags__name: 'ts' }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(titles(await Post.objects.filter({ tags: f.tagFun }))).toEqual(['Life notes'])
    expect(titles(await Post.objects.filter({ tags__in: [f.tagJs, f.tagFun] }))).toEqual(['Hello Ghuri', 'Life notes'])
    expect(titles(await Post.objects.filter({ tags__isnull: true }))).toEqual(['Draft'])
    expect(titles(await Post.objects.exclude({ tags__name: 'ts' }))).toEqual(['Draft', 'Life notes'])
    // reverse M2M
    expect((await Tag.objects.filter({ posts__author__name: 'Ann' })).map((t) => t.name)).toEqual(['js', 'ts'])
    expect((await Tag.objects.filter({ posts__published: false })).map((t) => t.name)).toEqual(['fun'])
    // multi-hop: authors who have a post tagged 'fun'
    expect((await Author.objects.filter({ posts__tags__name: 'fun' })).map((a) => a.name)).toEqual(['Bob'])
    // self-referential reverse relation
    expect((await Category.objects.filter({ children__name: 'JS' })).map((c) => c.name)).toEqual(['Tech'])
    // conditions in one filter() call apply to the same related row
    expect((await Author.objects.filter({ posts__published: true, posts__views__lt: 5 })).length).toBe(0)
    expect((await Author.objects.filter({ posts__published: true }).filter({ posts__views__lt: 5 })).length).toBe(0)
    expect((await Author.objects.filter({ posts__published: false }).filter({ posts__views__lt: 5 })).map((a) => a.name)).toEqual(['Bob'])
    // results are not duplicated by multi-valued filters
    expect(await Post.objects.filter({ tags__name__in: ['js', 'ts'] }).count()).toBe(2)
  })

  it('subqueries with querysets as values', async () => {
    await blogFixture()
    const active = Author.objects.filter({ isActive: true })
    expect(titles(await Post.objects.filter({ author__in: active }))).toEqual(['Hello Ghuri', 'Typed ORM'])
    const ids = Author.objects.filter({ name: 'Bob' }).valuesList('id', { flat: true })
    expect(titles(await Post.objects.filter({ author__in: ids }))).toEqual(['Draft', 'Life notes'])
  })

  it('invalid lookups raise FieldError', async () => {
    await expect(Post.objects.filter({ nope: 1 }).count()).rejects.toBeInstanceOf(FieldError)
    await expect(Post.objects.filter({ title__nope: 1 }).count()).rejects.toBeInstanceOf(FieldError)
    await expect(Post.objects.filter({ nope: 1 }).count()).rejects.toThrow(/Choices are/)
  })
})
