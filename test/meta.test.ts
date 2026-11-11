import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppConfig, apps, Http404 } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  BaseModel,
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  DecimalField,
  ForeignKey,
  getObjectOr404,
  getTable,
  IntegerField,
  type Manager,
  ManyToManyField,
  Model,
  RelatedObject,
  registerModels,
} from '../src/index'
import { fieldFromSpec, type PostgresSchemaEditor, schemaEditorFor } from '../src/migrations'
import { setupTestDatabase } from '../src/testing'
import { Author, allModels, Comment, Post, Tag } from './models'

// Reverse relations are known once the declaring models are registered (INSTALLED_APPS does this).
registerModels('tests', allModels)

const here = dirname(fileURLToPath(import.meta.url))

describe('Model._meta', () => {
  it('exposes Django-compatible options', () => {
    const meta = Post._meta
    expect(meta.appLabel).toBe('tests')
    expect(meta.objectName).toBe('Post')
    expect(meta.modelName).toBe('post')
    expect(meta.label).toBe('tests.Post')
    expect(meta.labelLower).toBe('tests.post')
    expect(meta.dbTable).toBe('tests_post')
    expect(meta.pk.name).toBe('id')
    expect(meta.pk.internalType).toBe('BigAutoField')
    expect(meta.fields.map((f) => f.name).slice(0, 4)).toEqual(['id', 'title', 'slug', 'body'])
    expect(meta.fields.some((f) => f.name === 'tags')).toBe(false)
    expect(meta.manyToMany.map((f) => f.name)).toEqual(['tags'])
    expect(meta.concreteFields.length).toBe(meta.localFields.length)
    expect(meta.ordering).toEqual(['-createdAt', '-id'])
    expect(meta.uniqueTogether).toEqual([['title', 'author']])
    expect(meta.verboseName).toBe('post')
    expect(meta.verboseNamePlural).toBe('posts')
    expect(meta.defaultPermissions).toEqual(['add', 'change', 'delete', 'view'])
    const author = meta.getField('author') as ForeignKey
    expect(author).toBeInstanceOf(ForeignKey)
    expect(author.attname).toBe('authorId')
    expect(author.column).toBe('author_id')
    expect(author.relatedModel).toBe(Author)
    expect(meta.getField('authorId')).toBe(author)
    expect(meta.getForwardField('createdAt')!.column).toBe('created_at')
    expect(meta.getField('comments')).toBeInstanceOf(RelatedObject)
    expect(() => meta.getField('nope')).toThrow(/has no field named 'nope'/)
    expect(Author._meta.relatedObjects.map((r) => r.name).sort()).toEqual(['comments', 'posts', 'profile'])
    expect(Comment._meta.getField('post').isRelation).toBe(true)
  })

  it('field API: deconstruct, formHint, jsonSchema, defaults, choices', () => {
    const meta = Post._meta
    const title = meta.getField('title') as CharField
    expect(title.deconstruct()).toEqual({ type: 'CharField', options: { maxLength: 200 } })
    expect((meta.getField('author') as ForeignKey).deconstruct()).toEqual({
      type: 'ForeignKey',
      options: { to: 'tests.Author', onDelete: 'CASCADE', relatedName: 'posts', dbIndex: true },
    })
    expect((meta.getField('tags') as ManyToManyField).deconstruct().options).toMatchObject({
      to: 'tests.Tag',
      blank: true,
    })
    expect(meta.getForwardField('rating')!.deconstruct().options).toMatchObject({
      maxDigits: 5,
      decimalPlaces: 2,
      null: true,
    })
    expect(title.formHint()).toMatchObject({ widget: 'text', maxLength: 200, required: true, label: 'Title' })
    expect((meta.getField('status') as CharField).formHint()).toMatchObject({
      widget: 'select',
      choices: [
        ['draft', 'Draft'],
        ['live', 'Live'],
      ],
    })
    expect(meta.getForwardField('tags')!.formHint()).toMatchObject({
      widget: 'select-multiple',
      relatedModel: 'tests.Tag',
    })
    expect(meta.getForwardField('createdAt')!.formHint()).toMatchObject({
      widget: 'datetime',
      disabled: true,
    })
    expect(meta.getForwardField('published')!.formHint().widget).toBe('checkbox')
    expect(meta.pk.formHint().widget).toBe('hidden')
    expect(title.jsonSchema()).toMatchObject({ type: 'string', maxLength: 200, title: 'Title' })
    expect(meta.getForwardField('rating')!.jsonSchema()).toMatchObject({
      type: ['string', 'null'],
      format: 'decimal',
    })
    expect(meta.getForwardField('author')!.jsonSchema()).toMatchObject({
      type: 'integer',
      'x-related-model': 'tests.Author',
    })
    expect(meta.getForwardField('tags')!.jsonSchema()).toMatchObject({
      type: 'array',
      items: { type: 'integer' },
    })
    expect(meta.getForwardField('status')!.jsonSchema()).toMatchObject({
      enum: ['draft', 'live'],
      default: 'draft',
    })
    expect(meta.getForwardField('views')!.getDefault()).toBe(0)
    expect(meta.getForwardField('metadata')!.getDefault()).toEqual({})
    expect(meta.getForwardField('metadata')!.getDefault()).not.toBe(
      meta.getForwardField('metadata')!.getDefault(),
    )
    expect(meta.getForwardField('body')!.getDefault()).toBe('')
    expect(new DecimalField({ decimalPlaces: 2 }).toPython(1.5)).toBe('1.50')
    expect(() => new IntegerField().toPython('x')).toThrow(/must be an integer/)
    expect(new BooleanField().toPython('on')).toBe(true)
    expect(new DateTimeField().toPython('2024-01-01 10:00')).toEqual(new Date('2024-01-01T10:00:00Z'))
    const rebuilt = fieldFromSpec({ type: 'ForeignKey', to: 'tests.Author', onDelete: 'PROTECT', null: true })
    expect(rebuilt).toBeInstanceOf(ForeignKey)
    expect((rebuilt as ForeignKey).onDelete).toBe('PROTECT')
    expect(fieldFromSpec({ type: 'CharField', options: { maxLength: 9 } }).maxLength).toBe(9)
  })

  it('abstract models: extends option, spread fields, inherited Meta and methods', () => {
    class Timestamped extends Model({
      createdAt: new DateTimeField({ autoNowAdd: true }),
    }) {
      static Meta = { abstract: true, ordering: ['-createdAt'] }
      age(): number {
        return 1
      }
    }
    class Article extends Model({ title: new CharField({ maxLength: 10 }) }, { extends: Timestamped }) {
      static Meta = { appLabel: 'absapp' }
      declare static objects: Manager<Article>
    }
    class Note extends Model({ ...Timestamped.fields, text: new CharField() }) {
      static Meta = { appLabel: 'absapp' }
    }
    expect(Timestamped._meta.abstract).toBe(true)
    expect(() => new Timestamped()).toThrow(/Abstract model/)
    expect(() => Timestamped.objects).toThrow(/abstract/)
    expect(Article._meta.fields.map((f) => f.name)).toEqual(['id', 'createdAt', 'title'])
    expect(Article._meta.ordering).toEqual(['-createdAt'])
    expect(Article._meta.abstract).toBe(false)
    expect(Article._meta.dbTable).toBe('absapp_article')
    expect(new Article({ title: 'x' }).age()).toBe(1)
    expect(new Article({ title: 'x' })).toBeInstanceOf(BaseModel)
    expect(Note._meta.fields.map((f) => f.name)).toEqual(['id', 'createdAt', 'text'])
    // fields are cloned per model
    expect(Article._meta.getField('createdAt')).not.toBe(Note._meta.getField('createdAt'))
    expect((Article._meta.getField('createdAt') as any).model).toBe(Article)
    expect(Article.DoesNotExist).not.toBe(Note.DoesNotExist)
    expect(new Article.DoesNotExist('x')).toBeInstanceOf(Error)
  })

  it('apps.populate assigns labels and resolves string relations', async () => {
    class Writer extends Model({ name: new CharField({ maxLength: 20 }) }) {}
    class Story extends Model({
      writer: new ForeignKey('library.Writer', { onDelete: CASCADE, relatedName: 'stories' }),
      editor: new ForeignKey('Writer', { onDelete: CASCADE, null: true, relatedName: '+' }),
      sequels: new ManyToManyField('self', { blank: true }),
    }) {}
    class LibraryConfig extends AppConfig {
      name = 'library'
      models = { Writer, Story, notAModel: 42 }
    }
    await apps.populate([LibraryConfig])
    expect(Writer._meta.appLabel).toBe('library')
    expect(Story._meta.dbTable).toBe('library_story')
    expect(apps.getModel('library.story')).toBe(Story)
    expect((Story._meta.getField('writer') as ForeignKey).relatedModel).toBe(Writer)
    expect((Story._meta.getField('editor') as ForeignKey).relatedModel).toBe(Writer)
    expect(Writer._meta.relatedObjects.map((r) => r.getAccessorName())).toEqual(['stories'])
    const sequels = Story._meta.getField('sequels') as ManyToManyField
    expect(sequels.through._meta.dbTable).toBe('library_story_sequels')
    expect(sequels.through._meta.concreteFields.map((f) => f.column)).toEqual([
      'id',
      'from_story_id',
      'to_story_id',
    ])
    // registerModels() is the same thing for scripts/tests
    class Loose extends Model({ x: new IntegerField() }) {}
    registerModels('loose', { Loose })
    expect(Loose._meta.label).toBe('loose.Loose')
  })

  it('schema editor emits portable DDL', () => {
    const sqlite = schemaEditorFor('sqlite')
    const pg = schemaEditorFor('postgresql')
    expect(sqlite.tableSql(Post)).toContain('"id" integer NOT NULL PRIMARY KEY AUTOINCREMENT')
    expect(sqlite.tableSql(Post)).toContain(
      '"author_id" integer NOT NULL REFERENCES "tests_author" ("id") DEFERRABLE INITIALLY DEFERRED',
    )
    expect(pg.tableSql(Post)).toContain('"id" bigint NOT NULL PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY')
    expect(pg.tableSql(Post)).toContain('"created_at" timestamp with time zone NOT NULL')
    expect(pg.tableSql(Post)).toContain('"rating" numeric(5, 2) NULL')
    expect(sqlite.tableSql(Post)).toContain('"slug" varchar(50) NOT NULL UNIQUE')
    expect(pg.tableSql(Tag)).toBe(
      'CREATE TABLE "tests_tag" ("id" bigint NOT NULL PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY, "name" varchar(50) NOT NULL UNIQUE)',
    )
    expect(
      (pg as PostgresSchemaEditor).foreignKeySql(Post, Post._meta.getField('author') as ForeignKey),
    ).toMatch(
      /^ALTER TABLE "tests_post" ADD CONSTRAINT "tests_post_author_id_[0-9a-f]{8}_fk" FOREIGN KEY \("author_id"\) REFERENCES "tests_author" \("id"\) DEFERRABLE INITIALLY DEFERRED$/,
    )
    expect(sqlite.createIndexSql(Post, { fields: ['-createdAt', 'slug'] })).toMatch(
      /^CREATE INDEX "tests_post_created_at_slug_[0-9a-f]{8}_idx" ON "tests_post" \("created_at" DESC, "slug"\)$/,
    )
  })

  it('collects DDL without executing (sqlmigrate)', async () => {
    const editor = schemaEditorFor('postgresql')
    await editor.run((e) => e.createModel(Post))
    const sql = editor.collectedSql.join('\n')
    expect(sql).toContain('CREATE TABLE "tests_post"')
    expect(sql).toContain('CREATE TABLE "tests_post_tags"')
    expect(sql).toContain('ADD CONSTRAINT')
    expect(sql).toContain('UNIQUE ("title", "author_id")')
  })

  it('drizzle tables per dialect', () => {
    const t = getTable(Post, 'postgresql')
    expect(t.title.name).toBe('title')
    expect(t.authorId.name).toBe('author_id')
    expect(getTable(Post, 'sqlite')).not.toBe(t)
    expect(Post.table('sqlite')).toBe(getTable(Post, 'sqlite'))
  })

  it('getObjectOr404', async () => {
    const db = await setupTestDatabase({ using: 'sqlite', models: [Author] })
    try {
      const a = await Author.objects.create({ name: 'Ann' })
      expect((await getObjectOr404(Author, { pk: a.pk })).name).toBe('Ann')
      expect((await getObjectOr404(Author.objects.filter({ name: 'Ann' }))).pk).toBe(a.pk)
      await expect(getObjectOr404(Author, { pk: 999 })).rejects.toBeInstanceOf(Http404)
    } finally {
      await db.teardown()
    }
  })

  it('postgres() adapter (no server available: lazy connect, wrapped errors)', async () => {
    const { postgres, DatabaseError, d1 } = await import('../src/index')
    const config = postgres({
      url: 'postgres://user:pw@127.0.0.1:1/db',
      max: 1,
      driverOptions: { connect_timeout: 2 },
    })
    expect(config.vendor).toBe('postgresql')
    expect(config.dialect).toBe('postgresql')
    expect(JSON.stringify(config.options)).not.toContain('pw')
    const conn = await config.connect({})
    expect(conn.features.supportsTransactions).toBe(true)
    await expect(conn.execute('SELECT 1')).rejects.toBeInstanceOf(DatabaseError)
    await conn.close()
    await expect(Promise.resolve(postgres({ hyperdrive: 'HD' }).connect({}))).rejects.toThrow(
      /Hyperdrive binding 'HD'/,
    )
    expect(() => d1('DB').connect({})).toThrow(/D1 binding 'DB' not found/)
  })

  it('main entry is Workers-safe (no Node-only static imports in its graph)', () => {
    const root = resolve(here, '../src')
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
        if (/^import\s+type\s/.test(m[0].trim()) || /^export\s+type\s/.test(m[0].trim())) continue
        if (spec.startsWith('.')) {
          const base = join(dirname(file), spec)
          const candidates = [`${base}.ts`, join(base, 'index.ts')]
          const next = candidates.find((c) => {
            try {
              readFileSync(c)
              return true
            } catch {
              return false
            }
          })
          if (next) visit(next)
        } else external.add(spec)
      }
    }
    visit(join(root, 'index.ts'))
    const forbidden = [...external].filter(
      (s) =>
        (s.startsWith('node:') && s !== 'node:async_hooks') ||
        ['fs', 'path', 'better-sqlite3', '@electric-sql/pglite', 'miniflare', 'pg', 'postgres'].includes(s),
    )
    expect(forbidden).toEqual([])
    expect([...seen].some((f) => f.endsWith('sqlite.ts') && !f.includes('schema'))).toBe(false)
  })
})
