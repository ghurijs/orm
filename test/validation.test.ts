import { ValidationError } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { backends, blogFixture, useTestDatabase } from './helpers'
import { Author, Comment, Owner, Post, Profile, Tag } from './models'

async function errorsOf(fn: () => Promise<unknown>): Promise<Record<string, string[]>> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof ValidationError) return e.toDict()
    throw e
  }
  throw new Error('expected ValidationError')
}

describe.each(backends)('fullClean (%s)', (backend) => {
  useTestDatabase(backend)

  it('field validation: blank, null, maxLength, choices, validators, type coercion', async () => {
    const { ann } = await blogFixture()
    const p = new Post({ title: '', slug: 'bad slug!', author: ann, status: 'nope', views: -1 })
    const errors = await errorsOf(() => p.fullClean())
    expect(errors.title).toEqual(['This field cannot be blank.'])
    expect(errors.slug?.[0]).toMatch(/valid “slug”/)
    expect(errors.status).toEqual(['Value "nope" is not a valid choice.'])
    expect(errors.views).toEqual(['Ensure this value is greater than or equal to 0.'])
    const long = new Tag({ name: 'x'.repeat(51) })
    expect((await errorsOf(() => long.fullClean())).name).toEqual(['Ensure this value has at most 50 characters (it has 51).'])
    const bad = new Author({ name: 'x', email: 'not-an-email', age: 'abc' as any })
    const e2 = await errorsOf(() => bad.fullClean())
    expect(e2.email).toEqual(['Enter a valid email address.'])
    expect(e2.age).toEqual(['“abc” value must be an integer.'])
    const coerced = new Author({ name: 'Zed', age: '42' as any })
    await coerced.fullClean()
    expect(coerced.age).toBe(42)
    const nullName = new Author({ name: null as any })
    expect((await errorsOf(() => nullName.fullClean())).name).toEqual(['This field cannot be null.'])
    const noAuthor = new Comment({ text: 'x', postId: 9999 })
    expect((await errorsOf(() => noAuthor.fullClean())).post?.[0]).toMatch(/does not exist/)
  })

  it('unique, uniqueTogether and exclude', async () => {
    const { ann, p1 } = await blogFixture()
    const dup = new Post({ title: 'Hello Ghuri', slug: 'hello-ghuri', author: ann })
    const errors = await errorsOf(() => dup.fullClean())
    expect(errors.slug).toEqual(['Post with this Slug already exists.'])
    expect(errors.__all__).toEqual(['Post with this Title and Author already exists.'])
    await expect(dup.fullClean({ exclude: ['slug', 'title'] })).resolves.toBeUndefined()
    // the instance itself is not a duplicate of itself
    await expect(p1.fullClean()).resolves.toBeUndefined()
    const tag = new Tag({ name: 'js' })
    expect((await errorsOf(() => tag.fullClean())).name).toEqual(['Tag with this Name already exists.'])
    await expect(tag.fullClean({ validateUnique: false })).resolves.toBeUndefined()
    const profile = await Profile.objects.create({ author: ann })
    const second = new Profile({ author: ann })
    expect((await errorsOf(() => second.fullClean())).author).toEqual(['Profile with this Author already exists.'])
    await expect(profile.fullClean()).resolves.toBeUndefined()
  })

  it('clean() hook errors are collected', async () => {
    expect(await errorsOf(() => new Owner({ name: 'forbidden' }).fullClean())).toEqual({ __all__: ['Forbidden name.'] })
    expect(await errorsOf(() => new Owner({ name: 'bad-field' }).fullClean())).toEqual({ name: ['Bad name.'] })
    await expect(new Owner({ name: 'fine' }).fullClean()).resolves.toBeUndefined()
  })
})
