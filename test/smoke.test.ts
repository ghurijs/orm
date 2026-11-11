import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Count } from '../src/index'
import { setupTestDatabase, type TestDatabase, testBackends } from '../src/testing'
import { Author, allModels, Post, Tag } from './models'

describe.each(testBackends())('smoke (%s)', (backend) => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await setupTestDatabase({ using: backend, models: allModels })
  })
  afterAll(async () => {
    await db.teardown()
  })

  it('creates, queries, relates', async () => {
    const a = await Author.objects.create({ name: 'Ann', email: 'ann@example.com' })
    expect(a.id).toBeTypeOf('number')
    const p = await Post.objects.create({ title: 'Hello', slug: 'hello', author: a, published: true })
    expect(p.createdAt).toBeInstanceOf(Date)
    const t = await Tag.objects.create({ name: 'js' })
    await p.tags.add(t)
    const posts = await Post.objects.filter({ author__name: 'Ann', tags__name: 'js' })
    expect(posts.map((x) => x.title)).toEqual(['Hello'])
    const author = await posts[0].author
    expect(author.name).toBe('Ann')
    expect(await a.posts.count()).toBe(1)
    const annotated = await Author.objects.annotate({ n: Count('posts') }).get({ pk: a.pk })
    expect((annotated as any).n).toBe(1)
    expect(await Post.published.count()).toBe(1)
  })
})
