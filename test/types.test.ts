import { describe, expect, it } from 'vitest'
import { getDrizzle } from '../src/index'
import { backends, useTestDatabase } from './helpers'
import { Sample } from './models'

describe.each(backends)('type round-trips (%s)', (backend) => {
  const ctx = useTestDatabase(backend)

  it('every scalar field survives save → load with the same JS value', async () => {
    const at = new Date('2024-02-29T12:34:56.789Z')
    const blob = new Uint8Array([0, 1, 2, 250, 255])
    const s = await Sample.objects.create({
      char: 'héllo ✓',
      text: 'multi\nline',
      int: -42,
      big: 9007199254740991,
      positive: 7,
      float: 3.5,
      dec: '1234.500',
      flag: true,
      day: '2024-02-29',
      at,
      time: '13:45:00',
      dur: 90_000,
      data: { a: [1, 2, { b: null }], s: 'x', n: 1.5, t: true },
      blob,
      uuid: '6F9619FF-8B86-D011-B42D-00CF4FC964FF',
      ip: '192.168.0.1',
    })
    const r = await Sample.objects.get({ pk: s.pk })
    expect(r.char).toBe('héllo ✓')
    expect(r.text).toBe('multi\nline')
    expect(r.int).toBe(-42)
    expect(r.big).toBe(9007199254740991)
    expect(r.positive).toBe(7)
    expect(r.float).toBe(3.5)
    expect(r.dec).toBe('1234.500')
    expect(r.flag).toBe(true)
    expect(r.day).toBe('2024-02-29')
    expect(r.at).toBeInstanceOf(Date)
    expect(r.at?.toISOString()).toBe(at.toISOString())
    expect(r.time).toBe('13:45:00')
    expect(r.dur).toBe(90_000)
    expect(r.data).toEqual({ a: [1, 2, { b: null }], s: 'x', n: 1.5, t: true })
    expect([...(r.blob as Uint8Array)]).toEqual([...blob])
    expect(r.uuid).toBe('6f9619ff-8b86-d011-b42d-00cf4fc964ff')
    expect(r.ip).toBe('192.168.0.1')

    const empty = await Sample.objects.create({})
    const e = await Sample.objects.get({ pk: empty.pk })
    expect([e.int, e.flag, e.at, e.data, e.blob, e.dec, e.day]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    const f = await Sample.objects.create({ flag: false, data: 'just a string', dec: 0.1 as any })
    const fr = await Sample.objects.get({ pk: f.pk })
    expect(fr.flag).toBe(false)
    expect(fr.data).toBe('just a string')
    expect(fr.dec).toBe('0.100')
  })

  it('filters use the same conversions (booleans, dates, decimals, json, uuid)', async () => {
    await Sample.objects.create({
      flag: true,
      at: new Date('2020-01-01T00:00:00Z'),
      dec: '2.500',
      uuid: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    })
    await Sample.objects.create({ flag: false, at: new Date('2021-01-01T00:00:00Z'), dec: '10.000' })
    expect(await Sample.objects.filter({ flag: true }).count()).toBe(1)
    expect(await Sample.objects.filter({ flag: 'false' }).count()).toBe(1)
    expect(await Sample.objects.filter({ at: new Date('2020-01-01T00:00:00Z') }).count()).toBe(1)
    expect(await Sample.objects.filter({ dec__gt: '3' }).count()).toBe(1)
    expect(await Sample.objects.filter({ dec__gt: 2.4 }).count()).toBe(2)
    expect(await Sample.objects.filter({ uuid: '6F9619FF8B86D011B42D00CF4FC964FF' }).count()).toBe(1)
    expect(await Sample.objects.filter({ uuid__icontains: '8b86' }).count()).toBe(1)
    expect(await Sample.objects.orderBy('dec').valuesList('dec', { flat: true })).toEqual(['2.500', '10.000'])
  })

  it('drizzle escape hatch shares the converted values', async () => {
    const at = new Date('2022-05-05T05:05:05.000Z')
    await Sample.objects.create({ flag: true, at, data: { k: 1 }, dec: '5.000' })
    const db = await getDrizzle()
    const table = Sample.table(ctx.db.connection.dialect)
    const rows = await db.select().from(table)
    expect(rows[0].flag).toBe(true)
    expect(rows[0].at).toBeInstanceOf(Date)
    expect(rows[0].at.toISOString()).toBe(at.toISOString())
    expect(rows[0].data).toEqual({ k: 1 })
    expect(rows[0].dec).toBe('5.000')
  })
})
