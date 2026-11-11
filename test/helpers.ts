import { afterAll, beforeAll, beforeEach } from 'vitest'
import { setupTestDatabase, type TestBackend, type TestDatabase, testBackends } from '../src/testing'
import { Author, allModels, Category, Comment, Post, Tag } from './models'

export const backends = testBackends()

/** Fresh database per describe block, flushed before every test. */
export function useTestDatabase(backend: TestBackend): { readonly db: TestDatabase } {
  const holder = {} as { db: TestDatabase }
  beforeAll(async () => {
    holder.db = await setupTestDatabase({ using: backend, models: allModels })
  }, 30_000)
  afterAll(async () => {
    await holder.db?.teardown()
  })
  beforeEach(async () => {
    await holder.db.flush()
  })
  return holder
}

/** A small blog fixture used by query tests. */
export async function blogFixture() {
  const ann = await Author.objects.create({ name: 'Ann', email: 'ann@example.com', age: 30 })
  const bob = await Author.objects.create({ name: 'Bob', email: 'bob@example.com', age: 40, isActive: false })
  const cid = await Author.objects.create({ name: 'Cid', email: null, age: null })
  const tech = await Category.objects.create({ name: 'Tech' })
  const js = await Category.objects.create({ name: 'JS', parent: tech })
  const life = await Category.objects.create({ name: 'Life' })
  const tagJs = await Tag.objects.create({ name: 'js' })
  const tagTs = await Tag.objects.create({ name: 'ts' })
  const tagFun = await Tag.objects.create({ name: 'fun' })
  const p1 = await Post.objects.create({
    title: 'Hello Ghuri',
    slug: 'hello-ghuri',
    body: 'First post about Ghuri',
    published: true,
    views: 10,
    rating: '4.50',
    author: ann,
    category: js,
    publishDate: '2024-01-15',
  })
  const p2 = await Post.objects.create({
    title: 'Typed ORM',
    slug: 'typed-orm',
    body: 'TypeScript all the way',
    published: true,
    views: 25,
    rating: '3.25',
    author: ann,
    category: tech,
    publishDate: '2024-03-02',
  })
  const p3 = await Post.objects.create({
    title: 'Life notes',
    slug: 'life-notes',
    body: '100% fun_stuff',
    published: false,
    views: 3,
    author: bob,
    category: life,
    publishDate: '2023-12-31',
  })
  const p4 = await Post.objects.create({
    title: 'Draft',
    slug: 'draft',
    published: false,
    views: 0,
    author: bob,
  })
  await p1.tags.add(tagJs, tagTs)
  await p2.tags.add(tagTs)
  await p3.tags.add(tagFun)
  const c1 = await Comment.objects.create({ post: p1, author: bob, text: 'Nice', score: 5, approved: true })
  const c2 = await Comment.objects.create({ post: p1, author: cid, text: 'Meh', score: 1 })
  const c3 = await Comment.objects.create({ post: p2, text: 'Great', score: 4, approved: true })
  return { ann, bob, cid, tech, js, life, tagJs, tagTs, tagFun, p1, p2, p3, p4, c1, c2, c3 }
}

export function titles(posts: Array<{ title: string }>): string[] {
  return posts.map((p) => p.title).sort()
}
