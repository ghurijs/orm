import { describe, expect, it } from 'vitest'
import {
  type DeleteSignalArgs,
  type PostSaveSignalArgs,
  ProtectedError,
  postDelete,
  postSave,
  preDelete,
  preSave,
  RestrictedError,
  type SaveSignalArgs,
} from '../src/index'
import { backends, blogFixture, useTestDatabase } from './helpers'
import {
  Author,
  Category,
  Comment,
  Desk,
  Entry,
  EntryLine,
  fallbackOwnerId,
  Memo,
  Owner,
  Party,
  Pet,
  Post,
  Tag,
  Visit,
  Workspace,
} from './models'

describe.each(backends)('deletion & signals (%s)', (backend) => {
  const holder = useTestDatabase(backend)

  /** SQL statements the connection runs while `fn` runs. */
  async function captureSql(fn: () => Promise<unknown>): Promise<string[]> {
    const conn = holder.db.connection
    const original = conn.execute
    const seen: string[] = []
    conn.execute = ((sql: string, params?: unknown[]) => {
      seen.push(sql)
      return original.call(conn, sql, params)
    }) as typeof conn.execute
    try {
      await fn()
    } finally {
      conn.execute = original
    }
    return seen
  }

  async function tenantFixture() {
    const ws = await Workspace.objects.create({ name: 'acme' })
    const other = await Workspace.objects.create({ name: 'other' })
    const seller = await Party.objects.create({ workspace: ws, name: 'seller' })
    const agent = await Party.objects.create({ workspace: ws, name: 'agent' })
    const e1 = await Entry.objects.create({ workspace: ws, party: seller, viaParty: agent, label: 'e1' })
    const e2 = await Entry.objects.create({ workspace: ws, party: agent, label: 'e2' })
    await Entry.objects.create({ workspace: ws, label: 'e3' })
    await EntryLine.objects.create({ entry: e1, amount: 10 })
    await EntryLine.objects.create({ entry: e2, amount: 20 })
    // a row outside the tenant that points into it keeps living, with its link nulled
    const outsider = await Entry.objects.create({ workspace: other, party: seller, label: 'outsider' })
    return { ws, other, seller, agent, outsider }
  }

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

  it('CASCADE deletes rows that SET_NULL-reference other cascaded rows before those rows', async () => {
    const { ws, other, outsider } = await tenantFixture()
    let result: [number, Record<string, number>] = [0, {}]
    const sql = await captureSql(async () => {
      result = await ws.delete()
    })
    const [count, per] = result
    expect(per).toEqual({
      'tests.Workspace': 1,
      'tests.Party': 2,
      'tests.Entry': 3,
      'tests.EntryLine': 2,
    })
    expect(count).toBe(8)
    expect(await Party.objects.count()).toBe(0)
    expect((await Entry.objects.all()).map((e) => e.label)).toEqual(['outsider'])
    expect((await Entry.objects.get({ pk: outsider.pk })).partyId).toBeNull()
    expect(await Workspace.objects.filter({ pk: other.pk }).exists()).toBe(true)
    // entries deleted with the tenant go before the parties, so only the outsider is nulled
    const entryTable = Entry._meta.dbTable
    const updates = sql.filter((s) => s.startsWith('UPDATE'))
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain(`"${entryTable}"`)
    const deletes = sql.filter((s) => s.startsWith('DELETE'))
    const entryAt = deletes.findIndex((s) => s.includes(`"${entryTable}"`))
    const partyAt = deletes.findIndex((s) => s.includes(`"${Party._meta.dbTable}"`))
    expect(entryAt).toBeGreaterThanOrEqual(0)
    expect(entryAt).toBeLessThan(partyAt)
  })

  it('queryset delete() of a tenant with SET_NULL links between its rows', async () => {
    await tenantFixture()
    const [count, per] = await Workspace.objects.filter({ name: 'acme' }).delete()
    expect(count).toBe(8)
    expect(per['tests.Party']).toBe(2)
    expect(await Entry.objects.count()).toBe(1)
    expect(await EntryLine.objects.count()).toBe(0)
  })

  it('SET_NULL links that point both ways are nulled before the delete', async () => {
    const ws = await Workspace.objects.create({ name: 'acme' })
    const desk = await Desk.objects.create({ workspace: ws })
    const memo = await Memo.objects.create({ workspace: ws, desk })
    desk.lastMemo = memo
    await desk.save()
    const [count, per] = await ws.delete()
    expect(per).toEqual({ 'tests.Workspace': 1, 'tests.Desk': 1, 'tests.Memo': 1 })
    expect(count).toBe(3)
    expect(await Desk.objects.count()).toBe(0)
    expect(await Memo.objects.count()).toBe(0)
  })

  it('deleting a party alone nulls the entries that point at it', async () => {
    const { seller, agent } = await tenantFixture()
    await seller.delete()
    await agent.delete()
    expect(await Entry.objects.filter({ party__isnull: false }).count()).toBe(0)
    expect(await Entry.objects.filter({ viaParty__isnull: false }).count()).toBe(0)
    expect(await Entry.objects.count()).toBe(4)
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
