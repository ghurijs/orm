import { AppConfig, apps } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Migration, migrate, operations as ops, RunCode, RunSQL, showMigrations } from '../src/migrations'
import { setupTestDatabase, type TestDatabase, testBackends } from '../src/testing'

const m = (n: string, opts: ConstructorParameters<typeof Migration>[0]) => {
  const mig = new Migration(opts)
  mig.name = n
  return mig
}

const migrations: Record<string, Migration> = {
  '0001_initial': m('0001_initial', {
    initial: true,
    operations: [
      ops.CreateModel({
        name: 'Category',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 50, unique: true },
        },
      }),
      ops.CreateModel({
        name: 'Product',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 100 },
          price: { type: 'DecimalField', maxDigits: 10, decimalPlaces: 2 },
          stock: { type: 'PositiveIntegerField', default: 0 },
          category: { type: 'ForeignKey', to: 'shop.Category', onDelete: 'CASCADE', null: true },
          created: { type: 'DateTimeField', autoNowAdd: true },
        },
        options: {
          indexes: [{ name: 'shop_product_name_idx', fields: ['name'] }],
          uniqueTogether: [['name', 'category']],
        },
      }),
    ],
  }),
  '0002_data': m('0002_data', {
    dependencies: [['shop', '0001_initial']],
    operations: [
      ops.RunCode(
        async (apps) => {
          const Category = apps.getModel('shop', 'Category')
          const Product = apps.getModel('shop.Product')
          const tools = await Category.objects.create({ name: 'Tools' })
          await Product.objects.create({ name: 'Hammer', price: '9.99', stock: 5, category: tools })
          await Product.objects.create({ name: 'Saw', price: '20.00' })
        },
        async (apps) => {
          await apps.getModel('shop.Product').objects.all().delete()
          await apps.getModel('shop.Category').objects.all().delete()
        },
      ),
    ],
  }),
  '0003_fields': m('0003_fields', {
    dependencies: [['shop', '0002_data']],
    operations: [
      ops.AddField({
        modelName: 'Product',
        name: 'sku',
        field: { type: 'CharField', maxLength: 20, default: 'none' },
      }),
      ops.AddField({
        modelName: 'Product',
        name: 'code',
        field: { type: 'CharField', maxLength: 10, null: true, unique: true },
      }),
      ops.AddField({
        modelName: 'Product',
        name: 'weight',
        field: { type: 'IntegerField', default: 1 },
        oneOffDefault: 7,
      }),
    ],
  }),
  '0004_alter': m('0004_alter', {
    dependencies: [['shop', '0003_fields']],
    operations: [
      ops.AlterField({ modelName: 'Product', name: 'name', field: { type: 'CharField', maxLength: 200 } }),
      ops.AlterField({
        modelName: 'Product',
        name: 'category',
        field: { type: 'ForeignKey', to: 'shop.Category', onDelete: 'CASCADE' },
        oneOffDefault: 1,
      }),
    ],
  }),
  '0005_renames': m('0005_renames', {
    dependencies: [['shop', '0004_alter']],
    operations: [
      ops.RenameField({ modelName: 'Product', oldName: 'stock', newName: 'quantity' }),
      ops.RenameModel({ oldName: 'Category', newName: 'Department' }),
    ],
  }),
  '0006_tags': m('0006_tags', {
    dependencies: [['shop', '0005_renames']],
    operations: [
      ops.CreateModel({
        name: 'Tag',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          label: { type: 'CharField', maxLength: 20 },
        },
      }),
      ops.AddField({
        modelName: 'Product',
        name: 'tags',
        field: { type: 'ManyToManyField', to: 'shop.Tag' },
      }),
      ops.RunSQL({
        sql: [
          "INSERT INTO shop_tag (id, label) VALUES (1, 'sale')",
          'INSERT INTO shop_product_tags (product_id, tag_id) VALUES (1, 1)',
        ],
        reverse: RunSQL.noop,
      }),
      ops.RenameField({ modelName: 'Product', oldName: 'tags', newName: 'labels' }),
    ],
  }),
  '0007_table': m('0007_table', {
    dependencies: [['shop', '0006_tags']],
    operations: [ops.AlterModelTable({ name: 'Product', table: 'shop_items' })],
  }),
  '0008_constraints': m('0008_constraints', {
    dependencies: [['shop', '0007_table']],
    operations: [
      ops.AddIndex({ modelName: 'Product', index: { name: 'shop_items_sku_idx', fields: ['sku'] } }),
      ops.AddConstraint({
        modelName: 'Product',
        constraint: { type: 'check', name: 'price_positive', check: '"price" >= 0' },
      }),
      ops.AddConstraint({
        modelName: 'Product',
        constraint: { type: 'unique', name: 'uniq_name_sku', fields: ['name', 'sku'] },
      }),
      ops.AlterUniqueTogether({ name: 'Product', uniqueTogether: [] }),
    ],
  }),
  '0009_removals': m('0009_removals', {
    dependencies: [['shop', '0008_constraints']],
    operations: [
      ops.RemoveIndex({ modelName: 'Product', name: 'shop_items_sku_idx' }),
      ops.RemoveConstraint({ modelName: 'Product', name: 'price_positive' }),
      ops.RemoveConstraint({ modelName: 'Product', name: 'uniq_name_sku' }),
      ops.RemoveField({ modelName: 'Product', name: 'code' }),
      ops.RemoveField({ modelName: 'Product', name: 'weight' }),
    ],
  }),
  '0010_sql': m('0010_sql', {
    dependencies: [['shop', '0009_removals']],
    operations: [
      ops.RunSQL({
        sqlite: "UPDATE shop_items SET sku = 'sq'",
        postgresql: "UPDATE shop_items SET sku = 'pg'",
        reverse: RunSQL.noop,
      }),
    ],
  }),
  '0011_delete': m('0011_delete', {
    dependencies: [['shop', '0010_sql']],
    operations: [
      ops.RemoveField({ modelName: 'Product', name: 'labels' }),
      ops.DeleteModel({ name: 'Tag' }),
      ops.RunCode(async () => {}, RunCode.noop),
    ],
  }),
}

class ShopConfig extends AppConfig {
  name = 'shop'
  override migrations = migrations
}

describe.each(testBackends())('migration operations (%s)', (backend) => {
  let db: TestDatabase
  const installed = [ShopConfig]
  const rows = async (sql: string) => (await db.connection.execute(sql)).rows
  const tables = async () => {
    const sql =
      db.connection.dialect === 'postgresql'
        ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1'
        : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY 1"
    return (await rows(sql)).map((r) => String(r.name))
  }
  const to = (target: string) => migrate({ appLabel: 'shop', target })

  beforeAll(async () => {
    await apps.populate(installed)
    db = await setupTestDatabase({ using: backend, models: [], createTables: false })
  })
  afterAll(async () => {
    await db?.teardown()
    apps.reset()
  })

  it('applies every operation forwards, preserving data', async () => {
    await to('0002')
    expect(await tables()).toEqual(
      expect.arrayContaining(['shop_category', 'shop_product', 'ghuri_migrations']),
    )
    expect(
      (await rows('SELECT name, stock FROM shop_product ORDER BY id')).map((r) => [r.name, Number(r.stock)]),
    ).toEqual([
      ['Hammer', 5],
      ['Saw', 0],
    ])

    await to('0003')
    const r3 = await rows('SELECT name, sku, code, weight FROM shop_product ORDER BY id')
    expect(r3.map((r) => [r.name, r.sku, r.code, Number(r.weight)])).toEqual([
      ['Hammer', 'none', null, 7],
      ['Saw', 'none', null, 7],
    ])
    // the unique column works
    await db.connection.execute("UPDATE shop_product SET code = 'A' WHERE name = 'Hammer'")
    await expect(
      db.connection.execute("UPDATE shop_product SET code = 'A' WHERE name = 'Saw'"),
    ).rejects.toThrow()

    await to('0004')
    const r4 = await rows('SELECT name, category_id FROM shop_product ORDER BY id')
    expect(r4.map((r) => [r.name, Number(r.category_id)])).toEqual([
      ['Hammer', 1],
      ['Saw', 1],
    ])
    await expect(db.connection.execute('UPDATE shop_product SET category_id = NULL')).rejects.toThrow()

    await to('0005')
    expect(await tables()).toContain('shop_department')
    expect(await tables()).not.toContain('shop_category')
    expect(
      (await rows('SELECT quantity FROM shop_product ORDER BY id')).map((r) => Number(r.quantity)),
    ).toEqual([5, 0])
    await expect(db.connection.execute('UPDATE shop_product SET quantity = -1')).rejects.toThrow()

    await to('0006')
    expect(await tables()).toContain('shop_product_labels')
    expect(await rows('SELECT product_id, tag_id FROM shop_product_labels')).toEqual([
      { product_id: 1, tag_id: 1 },
    ])

    await to('0007')
    expect(await tables()).toEqual(expect.arrayContaining(['shop_items', 'shop_items_labels']))
    expect(await tables()).not.toContain('shop_product')
    expect((await rows('SELECT COUNT(*) AS n FROM shop_items_labels'))[0].n).toBe(1)

    await to('0008')
    await expect(
      db.connection.execute("UPDATE shop_items SET price = -1 WHERE name = 'Saw'"),
    ).rejects.toThrow()
    expect((await rows('SELECT COUNT(*) AS n FROM shop_items'))[0].n).toBe(2)

    await to('0009')
    await db.connection.execute("UPDATE shop_items SET price = -1 WHERE name = 'Saw'")
    const cols9 = Object.keys((await rows('SELECT * FROM shop_items LIMIT 1'))[0])
    expect(cols9).not.toContain('code')
    expect(cols9).not.toContain('weight')
    expect((await rows('SELECT COUNT(*) AS n FROM shop_items_labels'))[0].n).toBe(1)

    await to('0010')
    expect((await rows('SELECT DISTINCT sku FROM shop_items'))[0].sku).toBe(
      backend === 'pglite' ? 'pg' : 'sq',
    )

    await to('0011')
    expect(await tables()).not.toContain('shop_tag')
    expect(await tables()).not.toContain('shop_items_labels')
    const status = await showMigrations({ appLabels: ['shop'] })
    expect(status.every((s) => s.applied)).toBe(true)
  })

  it('unapplies every operation backwards', async () => {
    await db.connection.execute('UPDATE shop_items SET price = 1 WHERE price < 0')
    await to('0009')
    const cols = Object.keys((await rows('SELECT * FROM shop_items LIMIT 1'))[0])
    expect(cols).toContain('sku')
    expect(await tables()).toContain('shop_items_labels')

    await to('0007')
    // RemoveField reversed with the field default; check / unique constraints gone again.
    expect((await rows('SELECT DISTINCT weight FROM shop_items'))[0].weight).toBe(1)
    await to('0005')
    expect(await tables()).toEqual(expect.arrayContaining(['shop_product', 'shop_department']))
    expect(await tables()).not.toContain('shop_product_labels')
    await to('0003')
    expect(await tables()).toContain('shop_category')
    expect((await rows('SELECT stock FROM shop_product ORDER BY id')).map((r) => Number(r.stock))).toEqual([
      5, 0,
    ])
    await db.connection.execute('UPDATE shop_product SET category_id = NULL WHERE id = 2')
    await to('0001')
    expect((await rows('SELECT COUNT(*) AS n FROM shop_product'))[0].n).toBe(0)
    await to('zero')
    expect(await tables()).toEqual(['ghuri_migrations'])
    const status = await showMigrations({ appLabels: ['shop'] })
    expect(status.some((s) => s.applied)).toBe(false)
  })

  it('re-applies everything from scratch', async () => {
    const res = await migrate()
    expect(res.plan.map((p) => p.migration.name)).toEqual(Object.keys(migrations))
    expect((await rows('SELECT COUNT(*) AS n FROM shop_items'))[0].n).toBe(2)
    const again = await migrate()
    expect(again.plan).toEqual([])
  })
})
