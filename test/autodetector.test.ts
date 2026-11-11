import { describe, expect, it } from 'vitest'
import {
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  ForeignKey,
  IntegerField,
  JSONField,
  ManyToManyField,
  SlugField,
  TextField,
} from '../src/index'
import {
  createModelClass,
  Migration,
  MigrationAutodetector,
  MigrationGraph,
  MigrationQuestionError,
  ModelRegistry,
  NonInteractiveQuestioner,
  ProjectState,
} from '../src/migrations'
import type { ModelClass, ModelMeta } from '../src/models/types'

type Def = { app: string; name: string; fields: Record<string, any>; meta?: ModelMeta }

/** Live-like models in an isolated registry → ProjectState (+ live model map). */
function build(defs: Def[]): { state: ProjectState; live: Map<string, ModelClass> } {
  const reg = new ModelRegistry({ isolated: true })
  const models = defs.map((d) => {
    const cls = createModelClass(d.name, d.fields, {
      meta: { ...(d.meta ?? {}), appLabel: d.app },
      registry: reg,
    })
    void cls._meta
    return cls
  })
  reg.checkPending()
  const live = new Map(models.map((m) => [ProjectState.key(m._meta.appLabel, m._meta.objectName), m]))
  return { state: ProjectState.fromModels(models), live }
}

async function diff(
  from: Def[],
  to: Def[],
  opts: {
    renames?: boolean
    defaults?: Record<string, unknown>
    graph?: MigrationGraph
    trim?: string[]
  } = {},
) {
  const a = build(from)
  const b = build(to)
  const q = new NonInteractiveQuestioner({ renames: opts.renames, defaults: opts.defaults })
  const det = new MigrationAutodetector(a.state, b.state, q, b.live)
  const changes = await det.changes(opts.graph ?? new MigrationGraph(), { trimToApps: opts.trim })
  const summary: Record<string, Array<{ name: string; deps: string[]; ops: string[] }>> = {}
  for (const [app, list] of changes) {
    summary[app] = list.map((m) => ({
      name: m.name,
      deps: m.dependencies.map((d) => `${d[0]}.${d[1]}`),
      ops: m.operations.map((o) => o.describe()),
    }))
  }
  return { changes, summary }
}

const user = (): Def => ({
  app: 'auth',
  name: 'User',
  fields: { username: new CharField({ maxLength: 150, unique: true }) },
})
const post = (extra: Record<string, any> = {}, meta?: ModelMeta): Def => ({
  app: 'blog',
  name: 'Post',
  fields: {
    title: new CharField({ maxLength: 100 }),
    author: new ForeignKey('auth.User', { onDelete: CASCADE }),
    ...extra,
  },
  meta,
})

/** Existing migrations so numbering and dependencies are realistic. */
function graphWith(...keys: Array<[string, string]>): MigrationGraph {
  const g = new MigrationGraph()
  let prev: Record<string, [string, string]> = {}
  for (const k of keys) {
    const m = new Migration()
    m.appLabel = k[0]
    m.name = k[1]
    g.addNode(k, m)
    if (prev[k[0]]) g.addDependency('test', k, prev[k[0]])
    prev = { ...prev, [k[0]]: k }
  }
  return g
}

describe('MigrationAutodetector', () => {
  it('creates initial migrations with cross-app dependencies', async () => {
    const { summary, changes } = await diff([], [user(), post()])
    expect(summary.auth).toEqual([{ name: '0001_initial', deps: [], ops: ['Create model User'] }])
    expect(summary.blog).toEqual([
      { name: '0001_initial', deps: ['auth.0001_initial'], ops: ['Create model Post'] },
    ])
    const create = changes.get('blog')![0].operations[0] as any
    expect(Object.keys(create.fields)).toEqual(['id', 'title', 'author'])
    expect(create.fields.author).toMatchObject({
      type: 'ForeignKey',
      options: { to: 'auth.User', onDelete: 'CASCADE' },
    })
    expect(changes.get('blog')![0].initial).toBe(true)
  })

  it('depends on the latest migration of other apps for existing models', async () => {
    const graph = graphWith(['auth', '0001_initial'], ['auth', '0002_more'], ['blog', '0001_initial'])
    const { summary } = await diff(
      [user(), post()],
      [
        user(),
        post({ editor: new ForeignKey('auth.User', { onDelete: CASCADE, null: true, relatedName: '+' }) }),
      ],
      { graph },
    )
    expect(summary.blog).toEqual([
      {
        name: '0002_post_editor',
        deps: ['blog.0001_initial', 'auth.0002_more'],
        ops: ['Add field editor to post'],
      },
    ])
  })

  it('adds, removes, alters and renames fields', async () => {
    const from = [user(), post({ body: new TextField(), views: new IntegerField({ default: 0 }) })]
    const to = [
      user(),
      {
        ...post({ body: new TextField({ null: true }), slug: new SlugField() }),
        fields: {
          headline: new CharField({ maxLength: 100 }),
          author: new ForeignKey('auth.User', { onDelete: CASCADE }),
          body: new TextField({ null: true }),
          slug: new SlugField(),
        },
      },
    ]
    await expect(diff(from, to, { renames: true })).rejects.toBeInstanceOf(MigrationQuestionError)
    const { summary, changes } = await diff(from, to, { renames: true, defaults: { 'blog.Post.slug': 'x' } })
    expect(summary.blog[0].ops).toEqual([
      'Rename field title on post to headline',
      'Remove field views from post',
      'Add field slug to post',
      'Alter field body on post',
    ])
    expect((changes.get('blog')![0].operations[2] as any).oneOffDefault).toBe('x')
    const noRename = await diff(from, to, {
      renames: false,
      defaults: { 'blog.Post.slug': 'x', 'blog.Post.headline': 'h' },
    })
    expect(noRename.summary.blog[0].ops).toEqual([
      'Remove field title from post',
      'Remove field views from post',
      'Add field headline to post',
      'Add field slug to post',
      'Alter field body on post',
    ])
  })

  it('asks for a one-off default when a field becomes NOT NULL', async () => {
    const from = [user(), post({ body: new TextField({ null: true }) })]
    const to = [user(), post({ body: new TextField() })]
    const q = new NonInteractiveQuestioner()
    const det = new MigrationAutodetector(build(from).state, build(to).state, q)
    const changes = await det.changes(new MigrationGraph())
    expect(changes.get('blog')![0].operations[0].describe()).toBe('Alter field body on post')
    expect(q.warnings[0]).toMatch(/nullable to non-nullable/)
    const { changes: c2 } = await diff(from, to, { defaults: { 'blog.Post.body': '' } })
    expect((c2.get('blog')![0].operations[0] as any).oneOffDefault).toBe('')
  })

  it('evaluates callable defaults once and never asks for auto-now fields', async () => {
    const from = [user(), post()]
    const to = [
      user(),
      post({
        meta: new JSONField({ default: () => ({ a: 1 }) }),
        created: new DateTimeField({ autoNowAdd: true }),
      }),
    ]
    const { changes } = await diff(from, to)
    const ops = changes.get('blog')![0].operations as any[]
    expect(ops.map((o) => o.name)).toEqual(['meta', 'created'])
    expect(ops[0].oneOffDefault).toEqual({ a: 1 })
    expect(ops[0].field.options.default).toEqual({ callable: 'default' })
    expect(ops[1].oneOffDefault).toBeUndefined()
  })

  it('renames models (keeping references) or recreates them', async () => {
    const comment = (target: string): Def => ({
      app: 'blog',
      name: 'Comment',
      fields: { post: new ForeignKey(target, { onDelete: CASCADE }) },
    })
    const from = [user(), post(), comment('blog.Post')]
    const to = [user(), { ...post(), name: 'Article' }, comment('blog.Article')]
    const graph = graphWith(['auth', '0001_initial'], ['blog', '0001_initial'])
    const renamed = await diff(from, to, { renames: true, graph })
    expect(renamed.summary.blog[0].ops).toEqual(['Rename model Post to Article'])
    expect(renamed.summary.blog[0].name).toBe('0002_rename_post_article')
    const recreated = await diff(from, to)
    expect(recreated.summary.blog[0].ops).toEqual([
      'Delete model Post',
      'Create model Article',
      'Alter field post on comment',
    ])
  })

  it('removes referencing fields before deleting models', async () => {
    const from = [
      user(),
      post(),
      {
        app: 'blog',
        name: 'Comment',
        fields: { post: new ForeignKey('blog.Post', { onDelete: CASCADE }), text: new TextField() },
      },
    ]
    const to = [user(), { app: 'blog', name: 'Comment', fields: { text: new TextField() } }]
    const { summary } = await diff(from, to)
    expect(summary.blog[0].ops).toEqual(['Remove field post from comment', 'Delete model Post'])
  })

  it('orders models by foreign keys and splits cycles', async () => {
    const a: Def = { app: 'blog', name: 'A', fields: { b: new ForeignKey('blog.B', { onDelete: CASCADE }) } }
    const b: Def = {
      app: 'blog',
      name: 'B',
      fields: { a: new ForeignKey('blog.A', { onDelete: CASCADE, null: true }) },
    }
    const { summary } = await diff([], [a, b])
    expect(summary.blog[0].ops).toEqual(['Create model B', 'Create model A', 'Add field a to b'])

    const x: Def = { app: 'one', name: 'X', fields: { y: new ForeignKey('two.Y', { onDelete: CASCADE }) } }
    const y: Def = {
      app: 'two',
      name: 'Y',
      fields: { x: new ForeignKey('one.X', { onDelete: CASCADE, null: true }) },
    }
    const cyc = await diff([], [x, y])
    expect(cyc.summary.one).toEqual([
      { name: '0001_initial', deps: [], ops: ['Create model X'] },
      { name: '0002_x_y', deps: ['one.0001_initial', 'two.0001_initial'], ops: ['Add field y to x'] },
    ])
    expect(cyc.summary.two).toEqual([
      { name: '0001_initial', deps: ['one.0001_initial'], ops: ['Create model Y'] },
    ])
  })

  it('handles many-to-many fields', async () => {
    const tag: Def = { app: 'blog', name: 'Tag', fields: { name: new CharField({ maxLength: 20 }) } }
    const created = await diff(
      [user()],
      [user(), tag, post({ tags: new ManyToManyField('blog.Tag', { blank: true }) })],
    )
    expect(created.summary.blog[0].ops).toEqual(['Create model Tag', 'Create model Post'])
    const added = await diff(
      [user(), tag, post()],
      [user(), tag, post({ tags: new ManyToManyField('blog.Tag') })],
    )
    expect(added.summary.blog[0].ops).toEqual(['Add field tags to post'])
    expect((added.changes.get('blog')![0].operations[0] as any).oneOffDefault).toBeUndefined()
    const toFk = await diff(
      [user(), tag, post({ tags: new ManyToManyField('blog.Tag') })],
      [user(), tag, post({ tags: new ForeignKey('blog.Tag', { onDelete: CASCADE, null: true }) })],
    )
    expect(toFk.summary.blog[0].ops).toEqual(['Remove field tags from post', 'Add field tags to post'])
  })

  it('detects indexes, constraints, unique together, table and options changes', async () => {
    const from = [
      user(),
      post(
        { published: new BooleanField({ default: false }) },
        { indexes: [{ fields: ['title'] }], uniqueTogether: [['title', 'author']] },
      ),
    ]
    const to = [
      user(),
      post(
        { published: new BooleanField({ default: false }) },
        {
          indexes: [{ fields: ['published'], name: 'post_pub_idx' }],
          constraints: [{ type: 'check', name: 'title_not_empty', check: '"title" <> \'\'' }],
          uniqueTogether: [['title', 'published']],
          ordering: ['-title'],
          dbTable: 'posts',
        },
      ),
    ]
    const { summary, changes } = await diff(from, to)
    expect(summary.blog[0].ops).toEqual([
      'Rename table for Post to posts',
      expect.stringMatching(/^Remove index blog_post_title_[0-9a-f]{8}_idx from Post$/),
      'Alter unique_together for Post (0 constraints)',
      'Alter unique_together for Post (1 constraint)',
      'Create index post_pub_idx on field(s) published of model Post',
      'Create constraint title_not_empty on model Post',
      'Change Meta options on Post',
    ])
    expect(changes.get('blog')![0].name).toMatch(/^0001_/)
    const same = await diff(to, to)
    expect(same.changes.size).toBe(0)
  })

  it('trims to requested apps plus the apps they need', async () => {
    const { summary } = await diff([], [user(), post()], { trim: ['blog'] })
    expect(Object.keys(summary).sort()).toEqual(['auth', 'blog'])
    const only = await diff([], [user(), post(), { app: 'shop', name: 'Item', fields: {} }], {
      trim: ['auth'],
    })
    expect(Object.keys(only.summary)).toEqual(['auth'])
  })
})
