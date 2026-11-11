import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppConfig, apps, bufferIO, callCommand } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerOrmCommands } from '../src/commands'
import {
  BooleanField,
  CASCADE,
  CharField,
  ForeignKey,
  type Manager,
  ManyToManyField,
  Model,
  modelRegistry,
  SET_NULL,
  TextField,
} from '../src/index'
import {
  MigrationLoader,
  makeMigrations,
  migrate,
  migrationsFromModule,
  showMigrations,
  sqlMigrate,
} from '../src/migrations'
import { setupTestDatabase, testBackends } from '../src/testing'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'ghuri-mm-'))
const libraryPath = join(root, 'library')
const accountsPath = join(root, 'accounts')
// like `ghuri startapp`: an empty migrations package per app
for (const p of [libraryPath, accountsPath]) {
  mkdirSync(join(p, 'migrations'), { recursive: true })
  writeFileSync(join(p, 'migrations', 'index.ts'), 'export const migrations = {}\n')
}
registerOrmCommands()

// ---- version 1 of the models ------------------------------------------------------------------------

class Member1 extends Model({ name: new CharField({ maxLength: 50 }) }) {
  static Meta = { objectName: 'Member' }
}
class Author1 extends Model({ name: new CharField({ maxLength: 100 }) }) {
  static Meta = { objectName: 'Author' }
}
class Tag1 extends Model({ name: new CharField({ maxLength: 20, unique: true }) }) {
  static Meta = { objectName: 'Tag' }
}
class Book1 extends Model({
  title: new CharField({ maxLength: 200 }),
  author: new ForeignKey('library.Author', { onDelete: CASCADE, relatedName: 'books' }),
  owner: new ForeignKey('accounts.Member', { onDelete: SET_NULL, null: true, relatedName: 'books' }),
  tags: new ManyToManyField('library.Tag', { blank: true, relatedName: 'books' }),
}) {
  static Meta = { objectName: 'Book' }
}

// ---- version 2 ------------------------------------------------------------------------------------

class Member extends Model({ name: new CharField({ maxLength: 50 }) }) {
  declare static objects: Manager<Member>
}
class Author extends Model({ name: new CharField({ maxLength: 100 }), bio: new TextField({ blank: true }) }) {
  declare static objects: Manager<Author>
}
class Tag extends Model({ name: new CharField({ maxLength: 20, unique: true }) }) {
  declare static objects: Manager<Tag>
}
class Book extends Model({
  title: new CharField({ maxLength: 200 }),
  isbn: new CharField({ maxLength: 13, default: '' }),
  available: new BooleanField({ default: true }),
  author: new ForeignKey(() => Author, { onDelete: CASCADE, relatedName: 'books' }),
  owner: new ForeignKey(() => Member, { onDelete: SET_NULL, null: true, relatedName: 'books' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'books' }),
}) {
  declare static objects: Manager<Book>
  static Meta = { ordering: ['title'], indexes: [{ fields: ['isbn'], name: 'library_book_isbn_idx' }] }
}

function configs(version: 1 | 2) {
  class AccountsConfig extends AppConfig {
    name = 'accounts'
    override path = accountsPath
    override models = version === 1 ? { Member1 } : { Member }
  }
  class LibraryConfig extends AppConfig {
    name = 'library'
    override path = libraryPath
    override models = version === 1 ? { Author1, Tag1, Book1 } : { Author, Tag, Book }
  }
  return [AccountsConfig, LibraryConfig]
}

const v2 = configs(2)

function biomeFormat(file: string): string {
  return execFileSync(
    'npx',
    [
      'biome',
      'format',
      '--indent-style=space',
      '--line-width=100',
      '--javascript-formatter-quote-style=single',
      '--semicolons=as-needed',
      '--stdin-file-path=test/generated-migration.ts',
    ],
    { input: readFileSync(file, 'utf8'), cwd: resolve(here, '..'), encoding: 'utf8' },
  )
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  apps.reset()
})

describe('makemigrations → files → migrate', () => {
  beforeAll(async () => {
    await apps.populate(configs(1))
  })

  it('writes initial migrations for every app with cross-app dependencies', async () => {
    const io = bufferIO()
    const res = await makeMigrations({ io })
    expect(res.migrations.map((g) => `${g.app}.${g.name}`)).toEqual([
      'accounts.0001_initial',
      'library.0001_initial',
    ])
    expect(io.out.join('\n')).toContain("Migrations for 'library':")
    expect(io.out.join('\n')).toContain('- Create model Book')
    const lib = readFileSync(join(libraryPath, 'migrations', '0001_initial.ts'), 'utf8')
    expect(lib).toContain("import { Migration, operations as ops } from '@ghuri/orm/migrations'")
    expect(lib).toContain("dependencies: [['accounts', '0001_initial']],")
    expect(lib).toContain('initial: true,')
    expect(lib).toContain(
      "tags: { type: 'ManyToManyField', to: 'library.Tag', blank: true, relatedName: 'books' },",
    )
    expect(lib).toMatch(
      /ops\.CreateModel\(\{\n {6}name: 'Author',\n {6}fields: \{\n {8}id: \{ type: 'BigAutoField', primaryKey: true \},/,
    )
    const index = readFileSync(join(libraryPath, 'migrations', 'index.ts'), 'utf8')
    expect(index).toContain("import m0001_initial from './0001_initial'")
    expect(index).toContain("'0001_initial': m0001_initial,")
    expect(existsSync(join(accountsPath, 'migrations', 'index.ts'))).toBe(true)
    // the generated TypeScript is already formatted
    expect(biomeFormat(join(libraryPath, 'migrations', '0001_initial.ts'))).toBe(lib)
    expect(biomeFormat(join(libraryPath, 'migrations', 'index.ts'))).toBe(index)
  })

  it('reads the files back (disk and index module) and detects no further changes', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    expect([...loader.migrations.keys()].sort()).toEqual(['accounts.0001_initial', 'library.0001_initial'])
    const ns = await import(join(libraryPath, 'migrations', 'index.ts'))
    const fromModule = migrationsFromModule(ns)!
    expect([...fromModule.keys()]).toEqual(['0001_initial'])
    const res = await makeMigrations({ io: bufferIO(), check: true })
    expect(res.exitCode).toBe(0)
    expect(res.migrations).toEqual([])
  })

  it('writes the next migration for model changes', async () => {
    for (const m of [Member1, Author1, Tag1, Book1]) modelRegistry.unregister(m)
    for (const m of [...modelRegistry.all])
      if (m._meta.autoCreated && ['library', 'accounts'].includes(m._meta.appLabel))
        modelRegistry.unregister(m)
    await apps.populate(v2)
    const dry = await makeMigrations({ io: bufferIO(), dryRun: true })
    expect(dry.migrations.length).toBe(1)
    expect(dry.migrations[0].name).toMatch(/^0002_/)
    expect(existsSync(join(libraryPath, 'migrations', `${dry.migrations[0].name}.ts`))).toBe(false)
    const check = await makeMigrations({ io: bufferIO(), check: true })
    expect(check.exitCode).toBe(1)
    const io = bufferIO()
    const res = await makeMigrations({ io, name: 'more' })
    expect(res.migrations.map((g) => `${g.app}.${g.name}`)).toEqual(['library.0002_more'])
    expect(res.migrations[0].migration.operations.map((o) => o.describe())).toEqual([
      'Add field bio to author',
      'Add field isbn to book',
      'Add field available to book',
      'Create index library_book_isbn_idx on field(s) isbn of model Book',
      'Change Meta options on Book',
    ])
    const src = readFileSync(join(libraryPath, 'migrations', '0002_more.ts'), 'utf8')
    expect(src).toContain("dependencies: [['library', '0001_initial']],")
    expect(biomeFormat(join(libraryPath, 'migrations', '0002_more.ts'))).toBe(src)
    const index = readFileSync(join(libraryPath, 'migrations', 'index.ts'), 'utf8')
    expect(index).toContain("'0002_more': m0002_more,")
    expect((await makeMigrations({ io: bufferIO(), check: true })).exitCode).toBe(0)
  })

  it('creates empty and merge migrations', async () => {
    const empty = await makeMigrations({ io: bufferIO(), empty: true, appLabels: ['accounts'], name: 'data' })
    expect(empty.migrations[0].name).toBe('0002_data')
    expect(empty.migrations[0].source).toContain('operations: [],')
    // a conflicting branch
    writeFileSync(
      join(accountsPath, 'migrations', '0002_other.ts'),
      "import { Migration } from '@ghuri/orm/migrations'\n\nexport default new Migration({ dependencies: [['accounts', '0001_initial']] })\n",
    )
    await expect(makeMigrations({ io: bufferIO() })).rejects.toThrow(/Conflicting migrations/)
    const merged = await makeMigrations({ io: bufferIO(), merge: true })
    expect(merged.migrations.map((g) => g.name)).toEqual(['0003_merge_0002_data_0002_other'])
    expect(merged.migrations[0].migration.dependencies).toEqual([
      ['accounts', '0002_data'],
      ['accounts', '0002_other'],
    ])
    const loader = await MigrationLoader.load()
    expect(loader.detectConflicts()).toEqual({})
  })

  it('sqlmigrate prints the SQL for both dialects', async () => {
    const sqlite = (await sqlMigrate('library', '0001', { dialect: 'sqlite' })).join('\n')
    expect(sqlite).toContain('-- Create model Book')
    expect(sqlite).toContain('CREATE TABLE "library_book"')
    expect(sqlite).toContain('REFERENCES "accounts_member" ("id") DEFERRABLE INITIALLY DEFERRED')
    expect(sqlite).toContain('CREATE TABLE "library_book_tags"')
    const pg = await sqlMigrate('library', '0002_more', { dialect: 'postgresql' })
    expect(pg[0]).toBe('BEGIN;')
    expect(pg.join('\n')).toContain(
      'ALTER TABLE "library_author" ADD COLUMN "bio" text NOT NULL DEFAULT \'\';',
    )
    expect(pg.join('\n')).toContain('CREATE INDEX "library_book_isbn_idx" ON "library_book" ("isbn");')
    const back = (await sqlMigrate('library', '0002', { dialect: 'sqlite', backwards: true })).join('\n')
    expect(back).toContain('DROP INDEX "library_book_isbn_idx"')
    expect(back).toContain('ALTER TABLE "library_author" DROP COLUMN "bio"')
  })
})

describe.each(testBackends())('generated migrations applied (%s)', (backend) => {
  it('migrates, runs ORM queries on the schema, unapplies and re-applies', async () => {
    await apps.populate(v2)
    const db = await setupTestDatabase({ using: backend, models: [], createTables: false })
    try {
      const io = bufferIO()
      await callCommand('migrate', { noInput: true }, io)
      const text = io.out.join('\n')
      expect(text).toContain('Applying accounts.0001_initial...')
      expect(text).toContain('library.0002_more OK')
      const ann = await Author.objects.create({ name: 'Ann' })
      const mem = await Member.objects.create({ name: 'Mo' })
      const t = await Tag.objects.create({ name: 'scifi' })
      const b = await Book.objects.create({ title: 'Dune', author: ann, owner: mem })
      await b.tags.add(t)
      expect(b.isbn).toBe('')
      expect(
        (await Book.objects.filter({ tags__name: 'scifi', author__name: 'Ann' })).map((x) => x.title),
      ).toEqual(['Dune'])

      const show = bufferIO()
      await callCommand('showmigrations', {}, show)
      expect(show.out.join('\n')).toContain(' [X] 0002_more')
      expect(show.out.join('\n')).toContain(' [X] 0003_merge_0002_data_0002_other')

      await callCommand('migrate', { app: 'library', target: '0001' }, bufferIO())
      const cols = (await db.connection.execute('SELECT * FROM library_book')).rows[0]
      expect(Object.keys(cols)).not.toContain('isbn')
      expect(cols.title).toBe('Dune')
      const status = await showMigrations({ appLabels: ['library'] })
      expect(status.map((s) => [s.name, s.applied])).toEqual([
        ['0001_initial', true],
        ['0002_more', false],
      ])
      const plan = bufferIO()
      await callCommand('migrate', { plan: true }, plan)
      expect(plan.out.join('\n')).toContain('library.0002_more\n    Add field bio to author')
      await migrate()
      expect((await Book.objects.get({ title: 'Dune' })).available).toBe(true)
      await migrate({ appLabel: 'library', target: 'zero' })
      await migrate({ appLabel: 'accounts', target: 'zero' })
      const left = await showMigrations()
      expect(left.filter((s) => s.applied)).toEqual([])
      await migrate()
      expect(await Book.objects.count()).toBe(0)
    } finally {
      await db.teardown()
    }
  })

  it('fakes migrations and fake-initial detects existing tables', async () => {
    await apps.populate(v2)
    const db = await setupTestDatabase({ using: backend, models: [], createTables: false })
    try {
      await migrate({ fake: true })
      expect((await showMigrations()).every((s) => s.applied)).toBe(true)
      await migrate({ appLabel: 'library', target: 'zero', fake: true })
      await migrate({ appLabel: 'accounts', target: 'zero', fake: true })
      // tables don't exist: fake-initial applies for real
      const io = bufferIO()
      await migrate({ fakeInitial: true, io })
      expect(io.out.join('\n')).not.toContain('FAKED')
      await migrate({ appLabel: 'library', target: '0001' })
      await migrate({ appLabel: 'library', target: 'zero', fake: true })
      await migrate({ appLabel: 'accounts', target: 'zero', fake: true })
      const io2 = bufferIO()
      await migrate({ fakeInitial: true, io: io2 })
      const text = io2.out.join('\n')
      expect(text).toContain('accounts.0001_initial FAKED (initial)')
      expect(text).toContain('library.0001_initial FAKED (initial)')
      expect(text).toContain('library.0002_more OK')
    } finally {
      await db.teardown()
    }
  })
})

describe('sqlmigrate --all (wrangler d1 migrations)', () => {
  it('writes numbered SQL files that apply on D1 and record themselves', async () => {
    await apps.populate(v2)
    const out = join(root, 'migrations-sql')
    const io = bufferIO()
    await callCommand('sqlmigrate', { all: true, out, dialect: 'sqlite' }, io)
    const files = readdirSync(out).sort()
    expect(files[0]).toBe('0001_accounts_0001_initial.sql')
    expect(files).toContain('0006_library_0002_more.sql')
    const first = readFileSync(join(out, files[0]), 'utf8')
    expect(first).toContain('CREATE TABLE IF NOT EXISTS "ghuri_migrations"')
    expect(first).toContain(
      `INSERT INTO "ghuri_migrations" ("app", "name", "applied") VALUES ('accounts', '0001_initial'`,
    )
    // re-running keeps existing files and writes nothing new
    const again = bufferIO()
    await callCommand('sqlmigrate', { all: true, out, dialect: 'sqlite' }, again)
    expect(again.out.join('\n')).toContain('No new migrations to write.')
    // apply them like wrangler does (each file in order) on a fresh D1 database
    const db = await setupTestDatabase({ using: 'd1', models: [], createTables: false })
    try {
      for (const f of files) await db.connection.executeScript(readFileSync(join(out, f), 'utf8'))
      const status = await showMigrations()
      expect(status.every((s) => s.applied)).toBe(true)
      const plan = await migrate()
      expect(plan.plan).toEqual([])
      const a = await Author.objects.create({ name: 'Zed', bio: 'x' })
      await Book.objects.create({ title: 'T', author: a })
      expect(await Book.objects.count()).toBe(1)
    } finally {
      await db.teardown()
    }
  })
})
