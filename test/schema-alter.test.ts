import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppConfig, apps, type CommandIO, plainStyle } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharField, type Manager, Model } from '../src/index'
import {
  InteractiveQuestioner,
  Migration,
  MigrationAutodetector,
  MigrationGraph,
  MigrationRecorder,
  ModelState,
  migrate,
  operations as ops,
  ProjectState,
  showMigrations,
} from '../src/migrations'
import { setupTestDatabase, type TestDatabase, testBackends } from '../src/testing'

const named = (name: string, opts: ConstructorParameters<typeof Migration>[0]) => {
  const m = new Migration(opts)
  m.name = name
  return m
}

const alterMigrations = {
  '0001_initial': named('0001_initial', {
    initial: true,
    operations: [
      ops.CreateModel({
        name: 'Owner',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 20 },
        },
      }),
      ops.CreateModel({
        name: 'Owner2',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          label: { type: 'CharField', maxLength: 20 },
        },
      }),
      ops.CreateModel({
        name: 'Item',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          code: { type: 'CharField', maxLength: 10 },
          qty: { type: 'IntegerField', default: 0 },
          owner: { type: 'ForeignKey', to: 'alt.Owner', onDelete: 'CASCADE', null: true },
          note: { type: 'CharField', maxLength: 20, null: true },
        },
      }),
      ops.RunSQL({
        sql: [
          "INSERT INTO alt_owner (id, name) VALUES (1, 'a'), (2, 'b')",
          "INSERT INTO alt_owner2 (id, label) VALUES (1, 'x'), (2, 'y')",
          "INSERT INTO alt_item (code, qty, owner_id, note) VALUES ('c1', 1, 1, 'n1'), ('c2', 2, 2, NULL)",
        ],
        reverse: [],
      }),
    ],
  }),
  '0002_alter': named('0002_alter', {
    dependencies: [['alt', '0001_initial']],
    operations: [
      ops.AlterField({
        modelName: 'Item',
        name: 'code',
        field: { type: 'CharField', maxLength: 10, unique: true },
      }),
      ops.AlterField({ modelName: 'Item', name: 'qty', field: { type: 'BigIntegerField', default: 5 } }),
      ops.AlterField({
        modelName: 'Item',
        name: 'owner',
        field: { type: 'ForeignKey', to: 'alt.Owner2', onDelete: 'CASCADE', null: true },
      }),
      ops.AlterField({
        modelName: 'Item',
        name: 'note',
        field: { type: 'CharField', maxLength: 20, null: true, dbIndex: true, dbColumn: 'memo' },
      }),
    ],
  }),
  '0003_unique': named('0003_unique', {
    dependencies: [['alt', '0002_alter']],
    operations: [
      ops.AlterField({ modelName: 'Item', name: 'code', field: { type: 'CharField', maxLength: 10 } }),
      ops.AlterField({
        modelName: 'Item',
        name: 'note',
        field: { type: 'CharField', maxLength: 20, null: true, dbColumn: 'memo' },
      }),
      ops.AlterUniqueTogether({ name: 'Item', uniqueTogether: [['code', 'qty']] }),
    ],
  }),
  '0004_table': named('0004_table', {
    dependencies: [['alt', '0003_unique']],
    operations: [
      ops.AlterModelTable({ name: 'Item', table: 'alt_items' }),
      ops.AlterUniqueTogether({ name: 'Item', uniqueTogether: [] }),
    ],
  }),
}

// Squashed migrations: 0001 + 0002 replaced by 0001_squashed_0002.
const sq1 = named('0001_initial', {
  operations: [ops.CreateModel({ name: 'S', fields: { id: { type: 'BigAutoField', primaryKey: true } } })],
})
const sq2 = named('0002_more', {
  dependencies: [['sq', '0001_initial']],
  operations: [ops.AddField({ modelName: 'S', name: 'n', field: { type: 'IntegerField', default: 0 } })],
})
const squashed = named('0001_squashed_0002', {
  replaces: [
    ['sq', '0001_initial'],
    ['sq', '0002_more'],
  ],
  operations: [
    ops.CreateModel({
      name: 'S',
      fields: { id: { type: 'BigAutoField', primaryKey: true }, n: { type: 'IntegerField', default: 0 } },
    }),
  ],
})

// An app with models and migrations: setupTestDatabase runs the migrations.
class Note extends Model({ text: new CharField({ maxLength: 50 }) }) {
  declare static objects: Manager<Note>
}

class AltConfig extends AppConfig {
  name = 'alt'
  override migrations = alterMigrations
}
class SqConfig extends AppConfig {
  name = 'sq'
  override migrations = { sq1, sq2, squashed }
}
class NotesConfig extends AppConfig {
  name = 'notes'
  override models = { Note }
  override migrations = {
    m0001: named('0001_initial', {
      initial: true,
      operations: [
        ops.CreateModel({
          name: 'Note',
          fields: {
            id: { type: 'BigAutoField', primaryKey: true },
            text: { type: 'CharField', maxLength: 50 },
          },
        }),
      ],
    }),
  }
}

const installed = [AltConfig, SqConfig, NotesConfig]

describe.each(testBackends())('schema editor alterations (%s)', (backend) => {
  let db: TestDatabase
  const rows = async (sql: string) => (await db.connection.execute(sql)).rows
  beforeAll(async () => {
    await apps.populate(installed)
    db = await setupTestDatabase({ using: backend, models: [Note] })
  })
  afterAll(async () => {
    await db?.teardown()
  })

  it('setupTestDatabase ran the app migrations', async () => {
    const recorded = await new MigrationRecorder(db.connection).appliedMigrations()
    expect([...recorded.keys()]).toContain('notes.0001_initial')
    await Note.objects.create({ text: 'hi' })
    expect(await Note.objects.count()).toBe(1)
  })

  it('alters unique, type, foreign key target, column name and indexes', async () => {
    await migrate({ appLabel: 'alt', target: '0002' })
    expect(
      (await rows('SELECT code, qty, owner_id, memo FROM alt_item ORDER BY id')).map((r) => [
        r.code,
        Number(r.qty),
        Number(r.owner_id),
        r.memo,
      ]),
    ).toEqual([
      ['c1', 1, 1, 'n1'],
      ['c2', 2, 2, null],
    ])
    await expect(db.connection.execute("UPDATE alt_item SET code = 'c1'")).rejects.toThrow()
    await db.connection.execute("INSERT INTO alt_owner2 (id, label) VALUES (9, 'z')")
    await db.connection.execute('UPDATE alt_item SET owner_id = 9 WHERE id = 1')
    if (backend !== 'd1') {
      // FK now points to alt_owner2 (id 9 doesn't exist in alt_owner)
      await expect(
        db.connection.transaction(async (c) => {
          await c.execute('UPDATE alt_item SET owner_id = 8 WHERE id = 1')
        }),
      ).rejects.toThrow()
    }
    await db.connection.execute('UPDATE alt_item SET owner_id = 1 WHERE id = 1')

    await migrate({ appLabel: 'alt', target: '0003' })
    await db.connection.execute("UPDATE alt_item SET code = 'same'")
    await expect(db.connection.execute('UPDATE alt_item SET qty = 1')).rejects.toThrow()
    await db.connection.execute('UPDATE alt_item SET qty = id')

    await migrate({ appLabel: 'alt', target: '0004' })
    await db.connection.execute('UPDATE alt_items SET qty = 1')
    expect((await rows('SELECT COUNT(*) AS n FROM alt_items'))[0].n).toBe(2)
    await db.connection.execute('UPDATE alt_items SET qty = id')
    await db.connection.execute("UPDATE alt_items SET code = 'c' || id")

    await migrate({ appLabel: 'alt', target: 'zero' })
    const remaining = await showMigrations({ appLabels: ['alt'] })
    expect(remaining.every((s) => !s.applied)).toBe(true)
    await migrate({ appLabel: 'alt' })
    expect((await rows('SELECT COUNT(*) AS n FROM alt_items'))[0].n).toBe(2)
  })

  it('uses squashed migrations when none of the replaced ones are applied', async () => {
    // setupTestDatabase migrated every app already
    await migrate({ appLabel: 'sq', target: 'zero' })
    const res = await migrate({ appLabel: 'sq' })
    expect(res.plan.map((p) => p.migration.name)).toEqual(['0001_squashed_0002'])
    const recorded = await new MigrationRecorder(db.connection).appliedMigrations()
    expect([...recorded.keys()].filter((k) => k.startsWith('sq.')).sort()).toEqual([
      'sq.0001_initial',
      'sq.0001_squashed_0002',
      'sq.0002_more',
    ])
    const status = await showMigrations({ appLabels: ['sq'] })
    expect(status).toMatchObject([
      { name: '0001_squashed_0002', applied: true, replaces: ['0001_initial', '0002_more'] },
    ])
    await migrate({ appLabel: 'sq', target: 'zero' })
    const after = await new MigrationRecorder(db.connection).appliedMigrations()
    expect([...after.keys()].filter((k) => k.startsWith('sq.'))).toEqual([])
  })
})

describe('InteractiveQuestioner', () => {
  it('asks about renames and one-off defaults through CommandIO', async () => {
    const asked: string[] = []
    const answers = ['1', '"hello"']
    const io: CommandIO = {
      stdout: () => {},
      stderr: () => {},
      style: plainStyle,
      confirm: async (q) => {
        asked.push(q)
        return true
      },
      prompt: async (q) => {
        asked.push(q)
        return answers.shift()!
      },
    }
    const from = new ProjectState([
      new ModelState('blog', 'Post', {
        id: { type: 'BigAutoField', primaryKey: true },
        title: { type: 'CharField', maxLength: 10 },
      }),
    ])
    const to = new ProjectState([
      new ModelState('blog', 'Post', {
        id: { type: 'BigAutoField', primaryKey: true },
        heading: { type: 'CharField', maxLength: 10 },
        slug: { type: 'SlugField' },
      }),
    ])
    const det = new MigrationAutodetector(from, to, new InteractiveQuestioner(io))
    const changes = await det.changes(new MigrationGraph())
    const ops2 = changes.get('blog')![0].operations as any[]
    expect(ops2.map((o) => o.describe())).toEqual([
      'Rename field title on post to heading',
      'Add field slug to post',
    ])
    expect(ops2[1].oneOffDefault).toBe('hello')
    expect(asked[0]).toBe('Was Post.title renamed to Post.heading (a CharField)?')
    expect(asked).toContain('Select an option: ')
  })
})

describe('Workers safety of @ghuri/orm/migrations', () => {
  it('has no Node-only static imports in its graph', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const seen = new Set<string>()
    const external = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(
        /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm,
      )) {
        const spec = m[1] ?? m[2]
        if (/^(import|export)\s+type\s/.test(m[0].trim())) continue
        if (spec.startsWith('.')) {
          const base = join(dirname(file), spec)
          for (const c of [`${base}.ts`, join(base, 'index.ts')]) {
            try {
              readFileSync(c)
              visit(c)
              break
            } catch {}
          }
        } else external.add(spec)
      }
    }
    visit(resolve(here, '../src/migrations.ts'))
    const forbidden = [...external].filter(
      (s) =>
        (s.startsWith('node:') && s !== 'node:async_hooks') ||
        ['fs', 'path', 'better-sqlite3', 'miniflare'].includes(s),
    )
    expect(forbidden).toEqual([])
    expect([...seen].some((f) => f.endsWith('migrations/node.ts'))).toBe(false)
  })
})
