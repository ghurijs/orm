import { describe, expect, it } from 'vitest'
import { captureQueries, type M2MChangedArgs, m2mChanged, Prefetch, RelatedRef } from '../src/index'
import { backends, blogFixture, titles, useTestDatabase } from './helpers'
import { Author, type Category, Comment, Post, Profile, Tag } from './models'

describe.each(backends)('relations (%s)', (backend) => {
  useTestDatabase(backend)

  it('FK forward: raw id, awaitable accessor, cache and assignment', async () => {
    const { ann, bob } = await blogFixture()
    const p = await Post.objects.get({ slug: 'hello-ghuri' })
    expect(p.authorId).toBe(ann.id)
    const ref = p.author
    expect(ref).toBeInstanceOf(RelatedRef)
    const [author, queries] = await captureQueries(async () => await p.author)
    expect(author.name).toBe('Ann')
    expect(queries.length).toBe(1)
    // cached: synchronous access now returns the instance
    expect((p.author as Author).name).toBe('Ann')
    const [, again] = await captureQueries(async () => await p.author)
    expect(again.length).toBe(0)
    p.author = bob
    expect(p.authorId).toBe(bob.id)
    expect((p.author as Author).name).toBe('Bob')
    await p.save()
    expect((await Post.objects.get({ pk: p.pk })).authorId).toBe(bob.id)
    // assigning a raw id clears the cache
    ;(p as any).author = ann.id
    expect(p.authorId).toBe(ann.id)
    expect((await p.author).name).toBe('Ann')
    // nullable FK resolves to null
    const draft = await Post.objects.get({ slug: 'draft' })
    expect(draft.categoryId).toBeNull()
    expect(await draft.category).toBeNull()
    // unsaved related object
    const ghost = new Author({ name: 'Ghost' })
    draft.author = ghost
    await expect(draft.save()).rejects.toThrow(/unsaved related object/)
    await ghost.save()
    await draft.save()
    expect((await Post.objects.get({ pk: draft.pk })).authorId).toBe(ghost.id)
    // non-nullable FK not set
    const orphan = new Post({ title: 'x', slug: 'x' })
    await expect(orphan.author).rejects.toBeInstanceOf(Author.DoesNotExist)
    expect(() => {
      ;(draft as any).author = new Tag({ name: 'no' })
    }).toThrow(/must be a "Author" instance/)
  })

  it('reverse FK manager: all / filter / count / create / add / remove / set / clear', async () => {
    const { ann, bob, tech, js, life } = await blogFixture()
    expect(titles(await ann.posts.all())).toEqual(['Hello Ghuri', 'Typed ORM'])
    expect(await ann.posts.filter({ views__gt: 20 }).count()).toBe(1)
    const created = await ann.posts.create({ title: 'New', slug: 'new' })
    expect(created.authorId).toBe(ann.id)
    expect(await ann.posts.count()).toBe(3)
    const moved = await Post.objects.get({ slug: 'draft' })
    await ann.posts.add(moved)
    expect(moved.authorId).toBe(ann.id)
    expect(await bob.posts.count()).toBe(1)
    // nullable reverse relation supports remove / clear / set
    expect((await tech.posts.all()).map((p) => p.slug)).toEqual(['typed-orm'])
    const p1 = await Post.objects.get({ slug: 'hello-ghuri' })
    await tech.posts.add(p1)
    expect(await tech.posts.count()).toBe(2)
    await tech.posts.remove(p1)
    expect(await tech.posts.count()).toBe(1)
    expect((await Post.objects.get({ pk: p1.pk })).categoryId).toBeNull()
    await life.posts.set([p1])
    expect((await life.posts.all()).map((p) => p.slug)).toEqual(['hello-ghuri'])
    await life.posts.clear()
    expect(await life.posts.count()).toBe(0)
    expect((await js.children.all()).length).toBe(0)
    expect((await tech.children.all()).map((c) => c.name)).toEqual(['JS'])
    await expect((ann.posts as any).remove(created)).rejects.toThrow(/not nullable/)
    // instance without pk can't use related managers
    expect(() => new Author({ name: 'x' }).posts.all()).toThrow(/needs to have a value/)
  })

  it('M2M managers: add / remove / set / clear / create and m2mChanged', async () => {
    const { p1, p4, tagJs, tagTs, tagFun } = await blogFixture()
    const events: Array<Pick<M2MChangedArgs, 'action' | 'reverse'> & { pks: unknown[] }> = []
    const receiver = (args: M2MChangedArgs) => {
      events.push({ action: args.action, reverse: args.reverse, pks: args.pkSet ? [...args.pkSet] : [] })
    }
    m2mChanged.connect(receiver)
    try {
      expect((await p1.tags.all()).map((t) => t.name)).toEqual(['js', 'ts'])
      await p4.tags.add(tagJs, tagTs.id)
      await p4.tags.add(tagJs) // already linked: no duplicate
      expect((await p4.tags.all()).map((t) => t.name)).toEqual(['js', 'ts'])
      await p4.tags.remove(tagJs)
      expect((await p4.tags.all()).map((t) => t.name)).toEqual(['ts'])
      await p4.tags.set([tagFun, tagTs])
      expect((await p4.tags.all()).map((t) => t.name)).toEqual(['fun', 'ts'])
      const newTag = await p4.tags.create({ name: 'new' })
      expect(newTag.id).toBeGreaterThan(0)
      expect(await p4.tags.count()).toBe(3)
      await p4.tags.clear()
      expect(await p4.tags.count()).toBe(0)
      // reverse side
      expect(titles(await tagTs.posts.all())).toEqual(['Hello Ghuri', 'Typed ORM'])
      await tagFun.posts.add(p1)
      expect((await p1.tags.all()).map((t) => t.name)).toEqual(['fun', 'js', 'ts'])
      expect(await tagFun.posts.filter({ published: true }).count()).toBe(1)
    } finally {
      m2mChanged.disconnect(receiver)
    }
    expect(events.slice(0, 2)).toEqual([
      { action: 'pre_add', reverse: false, pks: [tagJs.id, tagTs.id] },
      { action: 'post_add', reverse: false, pks: [tagJs.id, tagTs.id] },
    ])
    expect(events.some((e) => e.action === 'pre_remove')).toBe(true)
    expect(events.some((e) => e.action === 'post_clear')).toBe(true)
    expect(events.at(-1)).toEqual({ action: 'post_add', reverse: true, pks: [p1.id] })
  })

  it('one-to-one in both directions', async () => {
    const { ann, bob } = await blogFixture()
    const profile = await Profile.objects.create({
      author: ann,
      website: 'https://ann.dev',
      settings: { theme: 'dark' },
    })
    const fetched = await Author.objects.get({ pk: ann.pk })
    const viaReverse = await fetched.profile
    expect(viaReverse.website).toBe('https://ann.dev')
    expect((await (await Profile.objects.get({ pk: profile.pk })).author).name).toBe('Ann')
    await expect(Promise.resolve(bob.profile)).rejects.toBeInstanceOf(Profile.DoesNotExist)
    expect((await Author.objects.filter({ profile__website__contains: 'ann' })).map((a) => a.name)).toEqual([
      'Ann',
    ])
    expect((await Author.objects.filter({ profile__isnull: true })).map((a) => a.name)).toEqual([
      'Bob',
      'Cid',
    ])
    const withProfile = await Author.objects.selectRelated('profile').get({ pk: ann.pk })
    expect((withProfile.profile as Profile).settings).toEqual({ theme: 'dark' })
  })

  it('selectRelated joins forward relations in one query', async () => {
    await blogFixture()
    const [posts, queries] = await captureQueries(async () => {
      const list = await Post.objects.selectRelated('author', 'category__parent').orderBy('views')
      return list.map((p) => [
        p.title,
        (p.author as Author).name,
        p.category ? (p.category as Category).name : null,
        p.category && (p.category as Category).parent
          ? ((p.category as Category).parent as Category).name
          : null,
      ])
    })
    expect(queries.length).toBe(1)
    expect(posts).toEqual([
      ['Draft', 'Bob', null, null],
      ['Life notes', 'Bob', 'Life', null],
      ['Hello Ghuri', 'Ann', 'JS', 'Tech'],
      ['Typed ORM', 'Ann', 'Tech', null],
    ])
    const all = await Comment.objects.selectRelated().first()
    expect(all?._state.fieldsCache.has('post')).toBe(true)
  })

  it('prefetchRelated: reverse FK, M2M, nested, Prefetch objects', async () => {
    await blogFixture()
    const [result, queries] = await captureQueries(async () => {
      const authors = await Author.objects.prefetchRelated('posts', 'posts__tags', 'comments').orderBy('name')
      return authors.map((a) => a)
    })
    expect(queries.length).toBe(5) // authors, posts, through, tags, comments
    const ann = result[0]
    const [annPosts, q2] = await captureQueries(async () => await ann.posts.all())
    expect(q2.length).toBe(0)
    expect(titles(annPosts)).toEqual(['Hello Ghuri', 'Typed ORM'])
    const hello = annPosts.find((p) => p.slug === 'hello-ghuri')!
    const [tags, q3] = await captureQueries(async () => await hello.tags.all())
    expect(q3.length).toBe(0)
    expect(tags.map((t) => t.name).sort()).toEqual(['js', 'ts'])
    // chaining a prefetched manager queries again
    expect(await ann.posts.filter({ views__gt: 20 }).count()).toBe(1)
    // Prefetch with custom queryset and toAttr
    const posts = await Post.objects.prefetchRelated(
      new Prefetch('comments', {
        queryset: Comment.objects.filter({ approved: true }),
        toAttr: 'approvedComments',
      }),
      'author',
    )
    const p1 = posts.find((p) => p.slug === 'hello-ghuri') as any
    expect(p1.approvedComments.map((c: Comment) => c.text)).toEqual(['Nice'])
    expect(p1._state.fieldsCache.get('author').name).toBe('Ann')
    // reverse M2M
    const tagList = await Tag.objects.prefetchRelated('posts')
    const ts = tagList.find((t) => t.name === 'ts')!
    expect(titles(await ts.posts.all())).toEqual(['Hello Ghuri', 'Typed ORM'])
  })

  it('reverse accessor names, relatedObjects and through models', async () => {
    const meta = Author._meta
    const rels = meta.relatedObjects.map(
      (r) => `${r.relatedModel._meta.objectName}.${r.field.name}:${r.getAccessorName()}`,
    )
    expect(rels).toContain('Post.author:posts')
    expect(rels).toContain('Comment.author:comments')
    expect(rels).toContain('Profile.author:profile')
    const tagsField = Post._meta.getField('tags') as any
    expect(tagsField.through._meta.dbTable).toBe('tests_post_tags')
    expect(tagsField.through._meta.autoCreated).toBe(true)
    expect(tagsField.through._meta.concreteFields.map((f: any) => f.column)).toEqual([
      'id',
      'post_id',
      'tag_id',
    ])
    expect(Tag._meta.relatedObjects.some((r) => r.manyToMany && r.getAccessorName() === 'posts')).toBe(true)
  })
})
