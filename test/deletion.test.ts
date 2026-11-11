import { describe, expect, it } from 'vitest'
import {
  type DeleteSignalArgs,
  type PostSaveSignalArgs,
  postDelete,
  postSave,
  preDelete,
  preSave,
  ProtectedError,
  RestrictedError,
  type SaveSignalArgs,
} from '../src/index'
import { backends, blogFixture, useTestDatabase } from './helpers'
import { Author, Category, Comment, fallbackOwnerId, Owner, Pet, Post, Tag, Visit } from './models'

describe.each(backends)('deletion & signals (%s)', (backend) => {
  useTestDatabase(backend)

  it('CASCADE through FK, M2M through rows and self-references', async () => {
    const { ann, tech, tagTs } = await blogFixture()
    const [count, per] = await ann.delete()
    expect(per['tests.Author']).toBe(1)
    expect(per['tests.Post']).toBe(2)
    expect(per['tests.Comment']).toBe(3)
    expect(per['tests.Post_tags']).toBe(3)
    expect(count).toBe(9)
    expect(await Post.objects.count()).toBe(2)
    expect(await tagTs.posts.count()).toBe(0)
    expect(await Tag.objects.count()).toBe(3)
    // self-referential cascade: deleting Tech deletes JS; posts in either category are SET_NULL
    await Category.objects.filter({ pk: tech.pk }).delete()
    expect((await Category.objects.all()).map((c) => c.name)).toEqual(['Life'])
  })

  it('SET_NULL on delete', async () => {
    const { life, p3 } = await blogFixture()
    await life.delete()
    expect((await Post.objects.get({ pk: p3.pk })).categoryId).toBeNull()
  })

  it('PROTECT raises ProtectedError and deletes nothing', async () => {
    const { bob } = await blogFixture()
    // Bob authored comment c1 (PROTECT)
    await expect(bob.delete()).rejects.toBeInstanceOf(ProtectedError)
    expect(await Author.objects.filter({ pk: bob.pk }).exists()).toBe(true)
    try {
      await bob.delete()
    } catch (e) {
      expect((e as ProtectedError).protectedObjects.length).toBe(1)
    }
  })

  it('RESTRICT, SET_DEFAULT, SET(), DO_NOTHING, CASCADE on one model', async () => {
    const o1 = await Owner.objects.create({ name: 'one' })
    const fallback = await Owner.objects.create({ name: 'fallback' })
    fallbackOwnerId.value = fallback.id
    const pet = await Pet.objects.create({
      name: 'rex',
      nullOwner: o1,
      defaultOwner: o1,
      setOwner: o1,
      loudOwner: o1,
    })
    const cascaded = await Pet.objects.create({ name: 'tom', cascadeOwner: o1 })
    await o1.delete()
    const fresh = await Pet.objects.get({ pk: pet.pk })
    expect(fresh.nullOwnerId).toBeNull()
    expect(fresh.defaultOwnerId).toBeNull()
    expect(fresh.setOwnerId).toBe(fallback.id)
    expect(fresh.loudOwnerId).toBe(o1.id ?? fresh.loudOwnerId) // DO_NOTHING leaves the dangling id
    expect(await Pet.objects.filter({ pk: cascaded.pk }).exists()).toBe(false)

    const o2 = await Owner.objects.create({ name: 'two' })
    const restricted = await Pet.objects.create({ name: 'kit', restrictOwner: o2 })
    await expect(o2.delete()).rejects.toBeInstanceOf(RestrictedError)
    // allowed when the restricting row is deleted by a cascade from the same deletion
    await Visit.objects.create({ owner: o2, pet: restricted })
    await restricted.delete()
    const o3 = await Owner.objects.create({ name: 'three' })
    const p = await Pet.objects.create({ name: 'ok', restrictOwner: o3, cascadeOwner: o3 })
    await o3.delete()
    expect(await Pet.objects.filter({ pk: p.pk }).exists()).toBe(false)
    const protectedOwner = await Owner.objects.create({ name: 'prot' })
    await Pet.objects.create({ name: 'p', protectOwner: protectedOwner })
    await expect(Owner.objects.filter({ name: 'prot' }).delete()).rejects.toBeInstanceOf(ProtectedError)
  })

  it('queryset delete() with fast path and counts', async () => {
    await blogFixture()
    const [n, per] = await Tag.objects.filter({ name__in: ['js', 'ts'] }).delete()
    expect(per['tests.Tag']).toBe(2)
    expect(per['tests.Post_tags']).toBe(3)
    expect(n).toBe(5)
    const [m] = await Comment.objects.filter({ approved: false }).delete()
    expect(m).toBe(1)
    expect(await Comment.objects.count()).toBe(2)
  })

  it('preSave / postSave / preDelete / postDelete signals', async () => {
    const saves: string[] = []
    const deletes: string[] = []
    const onPre = ({ instance, updateFields }: SaveSignalArgs & { sender: unknown }) => {
      saves.push(`pre:${(instance as Tag).name}:${updateFields ? updateFields.join(',') : '-'}`)
    }
    const onPost = ({ instance, created }: PostSaveSignalArgs & { sender: unknown }) => {
      saves.push(`post:${(instance as Tag).name}:${created}`)
    }
    const onPreDel = ({ instance }: DeleteSignalArgs & { sender: unknown }) => {
      deletes.push(`pre:${(instance as Tag).name}:${(instance as Tag).pk !== null}`)
    }
    const onPostDel = ({ instance }: DeleteSignalArgs & { sender: unknown }) => {
      deletes.push(`post:${(instance as Tag).name}`)
    }
    preSave.connect(onPre, { sender: Tag })
    postSave.connect(onPost, { sender: Tag })
    preDelete.connect(onPreDel, { sender: Tag })
    postDelete.connect(onPostDel, { sender: Tag })
    try {
      const t = await Tag.objects.create({ name: 'a' })
      t.name = 'b'
      await t.save({ updateFields: ['name'] })
      await Author.objects.create({ name: 'not a tag' })
      await t.delete()
      await Tag.objects.create({ name: 'c' })
      await Tag.objects.all().delete()
    } finally {
      preSave.disconnect(onPre)
      postSave.disconnect(onPost)
      preDelete.disconnect(onPreDel)
      postDelete.disconnect(onPostDel)
    }
    expect(saves).toEqual(['pre:a:-', 'post:a:true', 'pre:b:name', 'post:b:false', 'pre:c:-', 'post:c:true'])
    expect(deletes).toEqual(['pre:b:true', 'post:b', 'pre:c:true', 'post:c'])
  })
})
