# @ghuri/orm

Django-style models, managers and QuerySets for TypeScript, on top of Drizzle. Runs on **Cloudflare D1** by
default and on **PostgreSQL** (postgres.js, Hyperdrive) or **SQLite** (better-sqlite3) by changing settings
only. Part of [Ghuri](https://github.com/ghurijs/ghuri) — Django for TypeScript, Cloudflare first.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```bash
npm install @ghuri/orm@next drizzle-orm
npm install postgres          # only if you use PostgreSQL
npm install -D better-sqlite3 @electric-sql/pglite miniflare   # local SQLite / tests
```

## Contents

- [Defining models](#defining-models)
- [Fields](#fields)
- [Querying](#querying)
- [Relations](#relations)
- [Saving, deleting, validation](#saving-deleting-validation)
- [Transactions](#transactions)
- [Databases and adapters](#databases-and-adapters)
- [Migrations](#migrations)
- [Data: dumpdata, loaddata, copydata, flush](#data-dumpdata-loaddata-copydata-flush)
- [Switching D1 → PostgreSQL](#switching-d1--postgresql)
- [Testing](#testing)
- [Escape hatches](#escape-hatches)
- [Differences from Django](#differences-from-django)

## Defining models

```ts
// src/blog/models.ts
import {
  BooleanField, CASCADE, CharField, DateTimeField, ForeignKey, Manager, ManyToManyField, Model,
  type RelatedManager, SlugField, TextField,
} from '@ghuri/orm'
import { User } from '@ghuri/auth'

export class Tag extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
}) {
  declare static objects: Manager<Tag>
  toString() { return this.name }
}

class PublishedManager extends Manager<Post> {
  getQueryset() { return super.getQueryset().filter({ published: true }) }
}

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  published: new BooleanField({ default: false }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  static Meta = { ordering: ['-createdAt'], indexes: [{ fields: ['slug'] }] }
  declare static objects: Manager<Post>      // results typed as Post (with your methods)
  static published = new PublishedManager()  // custom manager
  declare comments: RelatedManager<Comment>  // reverse relations are declared for typing
  toString() { return this.title }
}
```

Register the models with their app (this assigns the app label, `blog`, and the table name `blog_post`):

```ts
// src/blog/app.ts
import { AppConfig } from '@ghuri/core'
import * as models from './models'
export class BlogConfig extends AppConfig { name = 'blog'; models = models }
```

Outside `INSTALLED_APPS` (scripts, tests) use `Meta.appLabel` or `registerModels('blog', models)`.

- `Model({...})` returns a base class; instance properties are **inferred from the field map**
  (`post.title: string`, `post.authorId: number`, `post.publishedAt: Date | null` for `null: true`).
- `declare static objects: Manager<Post>` makes `Post.objects.get()` return `Post` (including your methods
  and declared reverse relations). Without it, results are typed from the fields only.
- Use `declare` (not class fields with initializers) for extra instance typings.
- An implicit `id: BigAutoField` primary key is added unless a field has `primaryKey: true`.
- Relation targets are lazy: `() => Model`, a model class, `'app.Model'`, `'Model'` (same app) or `'self'`.

### Meta

`dbTable` (default `${appLabel}_${modelname}`), `ordering`, `verboseName`, `verboseNamePlural`,
`uniqueTogether`, `indexes` (`{ fields: ['-createdAt', 'slug'], name?, unique?, condition? }`),
`constraints` (`{ type: 'unique', fields, name, condition? }` / `{ type: 'check', check, name }`), `abstract`,
`permissions`, `defaultPermissions` (`['add','change','delete','view']`), `getLatestBy`, `appLabel`,
`managed`, `defaultManagerName`.

### Abstract models

```ts
export class Timestamped extends Model({ createdAt: new DateTimeField({ autoNowAdd: true }) }) {
  static Meta = { abstract: true, ordering: ['-createdAt'] }
  age() { return Date.now() - this.createdAt.getTime() }
}
// inherit fields, Meta and methods:
export class Article extends Model({ title: new CharField() }, { extends: Timestamped }) {}
// or only the fields:
export class Note extends Model({ ...Timestamped.fields, text: new TextField() }) {}
```

### `_meta`

`Post._meta` is the stable introspection API used by admin, rest, agents and migrations:
`appLabel`, `modelName` (`'post'`), `objectName` (`'Post'`), `label` (`'blog.Post'`), `labelLower`,
`dbTable`, `pk`, `fields` (forward, non-M2M), `concreteFields`, `localFields`, `manyToMany`,
`relatedObjects` (reverse relations), `getField(name)` (forward by name/attname, or reverse by query name),
`getFields()`, `ordering`, `verboseName`, `verboseNamePlural`, `uniqueTogether`, `indexes`, `constraints`,
`permissions`, `defaultPermissions`.

## Fields

`AutoField`, `BigAutoField`, `SmallAutoField`, `CharField`, `TextField`, `SlugField`, `EmailField`,
`URLField`, `UUIDField`, `GenericIPAddressField`, `IntegerField`, `BigIntegerField`, `SmallIntegerField`,
`PositiveIntegerField`, `PositiveBigIntegerField`, `PositiveSmallIntegerField`, `FloatField`, `DecimalField`,
`BooleanField`, `DateField`, `DateTimeField`, `TimeField`, `DurationField`, `JSONField`, `BinaryField`,
`ForeignKey`, `OneToOneField`, `ManyToManyField`.

Common options: `null`, `blank`, `default` (value or function), `choices` (`[value, label][]` or an enum
object), `primaryKey`, `unique`, `dbIndex`, `dbColumn`, `editable`, `helpText`, `verboseName`,
`validators`, `errorMessages`, `dbDefault`. Field-specific: `maxLength`, `maxDigits`/`decimalPlaces`,
`autoNow`/`autoNowAdd`; relations: `onDelete`, `relatedName`, `relatedQueryName`, `toField`, `through`,
`throughFields`, `limitChoicesTo`, `dbConstraint`.

Values are portable — the same JS values on every backend:

| Field | JS value | SQLite / D1 | PostgreSQL |
|---|---|---|---|
| `DateTimeField` | `Date` | ISO-8601 UTC text | `timestamptz` |
| `DateField` | `'YYYY-MM-DD'` | text | `date` |
| `TimeField` | `'HH:MM:SS'` | text | `time` |
| `BooleanField` | `boolean` | integer 0/1 | `boolean` |
| `DecimalField` | `'12.50'` (string) | `decimal` (NUMERIC affinity) | `numeric(p, s)` |
| `JSONField` | any JSON | text | `jsonb` |
| `DurationField` | milliseconds | bigint | bigint |
| `UUIDField` | `'…-…'` string | `char(36)` | `uuid` |
| `BinaryField` | `Uint8Array` | blob | `bytea` |

Columns are snake_case (`createdAt` → `created_at`); a FK `author` stores `authorId` in column `author_id`.

Validators: `MinValueValidator`, `MaxValueValidator`, `MinLengthValidator`, `MaxLengthValidator`,
`RegexValidator`, `EmailValidator`, `URLValidator`, `DecimalValidator`, `validateSlug`, `validateEmail`,
`validateIPv4Address`, … A validator is an object with `validate(value)` or a function; both throw
`ValidationError` from `@ghuri/core`.

Field introspection for other packages: `internalType`, `toDb`, `fromDb`, `toPython`, `validate`,
`clean`, `deconstruct()`, `formHint()`, `jsonSchema()`, `getDefault()`, `dbType(dialect)`,
`drizzleColumn(dialect)`.

## Querying

QuerySets are lazy, immutable, chainable, **thenable** and async-iterable:

```ts
const posts = await Post.objects
  .filter({ published: true, title__icontains: 'ghuri', author__username: 'bob' })
  .exclude({ createdAt__lt: cutoff })
  .orderBy('-createdAt', 'title')
  .selectRelated('author')
  .prefetchRelated('tags')
  .slice(0, 10)

for await (const p of Post.objects.filter({ tags__name: 'ts' })) { /* … */ }

await Post.objects.get({ id: 1 })              // Post.DoesNotExist / Post.MultipleObjectsReturned
await qs.first(); await qs.last(); await qs.latest('createdAt'); await qs.count(); await qs.exists()
await qs.values('id', 'author__username')      // [{ id, author__username }]
await qs.valuesList('id', { flat: true })      // [1, 2, 3]
await qs.update({ views: F('views').add(1) })  // number of rows
await qs.delete()                               // [total, { 'blog.Post': n, … }]
await Post.objects.create({ title, slug, author: user })
await Post.objects.getOrCreate({ slug }, { defaults: { title } })       // [obj, created]
await Post.objects.updateOrCreate({ slug }, { defaults: { title } })    // [obj, created]
await Post.objects.bulkCreate([new Post({...}), new Post({...})])
await Post.objects.bulkUpdate(posts, ['title'])
await Post.objects.inBulk([1, 2, 3])            // Map<id, Post>
qs.distinct(); qs.only('id', 'title'); qs.defer('body'); qs.none(); qs.reverse(); qs.using('replica')
```

**Lookups**: `exact`, `iexact`, `contains`, `icontains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`,
`istartswith`, `endswith`, `iendswith`, `range`, `isnull`, `regex`, `iregex`; transforms `date`, `year`,
`month`, `day`, `hour`, `minute`, `second`, `week_day`, `quarter`, `time` (chainable: `createdAt__year__gte`).
`contains`/`startswith`/`endswith` are case-sensitive on every backend (SQLite uses `GLOB`), the `i…`
variants are case-insensitive. `regex` works on PostgreSQL and better-sqlite3; D1 raises `NotSupportedError`.

**Spanning relations** with `__` works across FK, reverse FK, one-to-one and M2M in both directions:
`Post.objects.filter({ tags__name: 'ts' })`, `Author.objects.filter({ posts__comments__approved: true })`.
Multi-valued relations compile to `EXISTS (…)` subqueries, so results are never duplicated; conditions in the
same `filter()` call apply to the same related row (like Django).

**Q and F**:

```ts
Post.objects.filter(Q({ a: 1 }).or(Q({ b: 2 })).and(Q.not({ c: 3 })))
Post.objects.filter({ views__gt: F('likes').mul(2) })
Post.objects.filter({ id: 1 }).update({ views: F('views').add(1) })
Post.objects.orderBy(F('rating').desc({ nullsLast: true }))
```

**Aggregation**: `Count`, `Sum`, `Avg`, `Min`, `Max` (with `{ distinct, filter }`), plus `Value`, `Lower`,
`Upper`, `Length`, `Coalesce`, `Concat`, `Now`, `RawSQL`.

```ts
await Post.objects.aggregate({ total: Count('id'), avg: Avg('views') })
await Author.objects.annotate({ numPosts: Count('posts') }).filter({ numPosts__gt: 2 })
await Post.objects.values('author').annotate({ n: Count('id') })   // GROUP BY author
await Post.objects.annotate({ ok: Count('comments', { filter: Q({ comments__approved: true }) }) })
```

Aggregates over reverse/M2M relations in `annotate()` compile to correlated subqueries (no row
multiplication when you combine several of them).

> QuerySets are thenable, so returning one from an `async` function resolves it to an array. Return it from a
> plain function (or wrap it in an object) when you want to keep the QuerySet.

## Relations

```ts
post.authorId                 // raw id
const author = await post.author   // loads once, then cached; sync access after selectRelated / await
post.author = user            // sets authorId
await user.posts.all()        // reverse FK manager
await user.posts.filter({ published: true }).count()
await user.posts.create({ title: 'x', slug: 'x' })
await post.tags.add(tag1, tag2); await post.tags.remove(tag1)
await post.tags.set([t]); await post.tags.clear(); await post.tags.all()
await tag.posts.all()         // reverse M2M
const profile = await user.profile   // reverse one-to-one (throws Profile.DoesNotExist)
```

Default reverse accessor names are `${modelName}Set` (`user.postSet`) and the lookup name is the
lower-camel model name (`filter({ post__title })`); set `relatedName` to choose (`'+'` hides it).
Reverse relations are known once the declaring model is registered (INSTALLED_APPS / `registerModels`).

`selectRelated('author', 'category__parent')` joins forward FKs / one-to-ones in the same query.
`prefetchRelated('tags', 'comments', 'posts__tags', new Prefetch('comments', { queryset, toAttr }))` runs one
extra query per relation.

`ON DELETE` is emulated by the ORM (like Django), identical on all backends: `CASCADE`, `PROTECT`
(→ `ProtectedError`), `RESTRICT` (→ `RestrictedError` unless also cascaded), `SET_NULL`, `SET_DEFAULT`,
`SET(value | fn)`, `DO_NOTHING`. Auto-created M2M tables are `${table}_${field}` with `${from}_id` /
`${to}_id` columns, like Django.

## Saving, deleting, validation

```ts
const p = new Post({ title: 'Hi', slug: 'hi', authorId: 1 })
await p.save()
await p.save({ updateFields: ['title'] })
await p.refreshFromDb()
await p.delete()               // [total, perModel]; emulates onDelete
await p.fullClean()            // throws ValidationError({ field: [messages] })
p.toJSON(); p.pk; Post.fromRow(row)
```

`fullClean()` runs field validation (null / blank / choices / validators / type coercion), your `clean()`,
foreign-key existence checks and uniqueness (`unique`, `uniqueTogether`, unique constraints) against the
database. Signals (`@ghuri/core` `Signal`): `preSave`, `postSave`, `preDelete`, `postDelete`, `m2mChanged`.

## Transactions

```ts
import { atomic, onCommit } from '@ghuri/orm'

await atomic(async () => {
  const a = await Author.objects.create({ name: 'Ann' })
  await atomic(async () => { /* nested: SAVEPOINT */ })
  await onCommit(() => sendEmail(a))
})
```

Inside `atomic()` every query on that alias uses the transaction. Nested blocks use savepoints.

**Concurrency on SQLite and PGlite.** `sqlite()` and `pglite()` share one connection among all concurrent
requests of the process (so do the test databases), and a transaction there covers the whole connection.
Ghuri therefore serialises transactions per connection: concurrent outermost `atomic()` blocks (and
`connection.batch()` / `connection.transaction()` calls) run one after the other, and queries from other
requests or tasks outside `atomic()` wait until the open transaction commits or rolls back instead of running
inside it (they never see its uncommitted rows, and a rollback never takes their writes with it). Django gets
the same isolation from one connection per thread. Code in the block's own async context — nested `atomic()`
(savepoints), `Promise.all` inside the block — runs in the transaction without waiting. Two consequences:
don't await, inside `atomic()`, work started in another async context that queries the same database (it
would wait for the block: deadlock), and keep blocks short, since they hold the connection. The drizzle escape
hatch (`getDrizzle()`) bypasses the lock. PostgreSQL (`postgres()`) gives each outermost block its own pooled
connection (`sql.begin`), so nothing is serialised there.

**D1 has no interactive transactions**: `atomic()` runs the callback directly (no isolation, no rollback;
`onCommit` callbacks still run after it succeeds). Use `(await connections.get()).batch([...])` for
all-or-nothing groups of statements on D1.

## Databases and adapters

```ts
// src/settings.ts
import { defineSettings } from '@ghuri/core'
import { d1, postgres } from '@ghuri/orm'

export default defineSettings((env) => ({
  // …
  DATABASES: { default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB') },
}))
```

| Adapter | Import | Runtime |
|---|---|---|
| `d1('DB')` | `@ghuri/orm` | Workers (binding name from `wrangler.jsonc`) |
| `postgres({ url })` / `postgres({ hyperdrive: 'HYPERDRIVE' })` | `@ghuri/orm` | Node, Workers (postgres.js, imported lazily) |
| `sqlite({ filename })` | `@ghuri/orm/sqlite` | Node (better-sqlite3) |
| `pglite({ dataDir? })` | `@ghuri/orm/pglite` | Node / tests (PostgreSQL in-process) |

`connections.get(alias)` returns the connection for the current request (Workers can't share I/O across
requests; per-request connections are closed when the request finishes) or for the process on Node/CLI.
`Connection` exposes `execute(sql, params)`, `batch()`, `transaction()`, `drizzle`, `features`, `close()`.

## Migrations

Django-style, **dialect-neutral** migrations: the same files run on D1, SQLite and PostgreSQL, which is what
makes moving between databases a settings change.

### Workflow

```bash
ghuri makemigrations            # detect model changes → src/<app>/migrations/NNNN_name.ts
ghuri migrate                   # apply them (default database)
ghuri showmigrations            # [X] applied / [ ] pending, per app
ghuri sqlmigrate blog 0002      # the SQL a migration runs (--dialect postgresql, --backwards)
ghuri migrate blog 0001         # roll back to a migration ('zero' unapplies the whole app)
```

Apps opt in with a `migrations` package (created by `ghuri startapp`) and `path`, which tells the CLI where
to write files:

```ts
// src/blog/app.ts
import { AppConfig } from '@ghuri/core'
import * as migrations from './migrations'
import * as models from './models'

export class BlogConfig extends AppConfig {
  name = 'blog'
  path = import.meta.dirname          // CLI only: where migrations/ lives
  models = models
  migrations = migrations             // the generated index: works on Workers (no file system)
}
```

A generated migration:

```ts
// src/blog/migrations/0002_post_slug.ts
import { Migration, operations as ops } from '@ghuri/orm/migrations'

export default new Migration({
  dependencies: [['blog', '0001_initial'], ['auth', '0001_initial']],
  operations: [
    ops.AddField({ modelName: 'Post', name: 'slug', field: { type: 'SlugField' }, oneOffDefault: 'post' }),
    ops.AlterField({ modelName: 'Post', name: 'body', field: { type: 'TextField', blank: true } }),
  ],
})
```

`makemigrations` also rewrites `migrations/index.ts`, which exports every migration
(`export { m0001_initial, … }` plus an ordered `migrations` map) so `import * as migrations from './migrations'`
is all a Worker needs.

**makemigrations** `[app...] [--name n] [--empty] [--dry-run] [--check] [--merge] [--no-input]`

- Detects created / deleted / renamed models and fields, altered fields, M2M fields, `Meta.indexes`,
  `Meta.constraints`, `uniqueTogether`, `dbTable` and other Meta options, with dependencies between apps
  (`['auth', '0001_initial']`; FK cycles between apps are split into two migrations).
- Interactive by default: asks whether a model / field was renamed, and for a one-off default when adding a
  NOT NULL field without default (or making a field NOT NULL). With `--no-input` renames are treated as
  remove + add and missing defaults are an error.
- Callable defaults (`default: () => ({})`) are evaluated once to fill existing rows; `autoNow` /
  `autoNowAdd` fields are filled with the current time.
- Names follow Django: `0001_initial`, `0002_post_slug`, `0003_remove_post_body`, `auto_YYYYMMDD_HHMM`.
  `--merge` creates a merge migration when two branches touched the same app.

**migrate** `[app] [target] [--fake] [--fake-initial] [--plan] [--run-syncdb] [--database alias]`

Each migration runs atomically together with its `ghuri_migrations` record: in a transaction on
SQLite / PostgreSQL, as one `batch()` on D1. `preMigrate` / `postMigrate` signals (exported from `@ghuri/orm`,
sender = the AppConfig, args `{ appConfig, using, plan }`) are sent for every installed app.

### Operations

`CreateModel`, `DeleteModel`, `RenameModel`, `AlterModelTable`, `AlterModelOptions`, `AddField`, `RemoveField`,
`AlterField`, `RenameField`, `AddIndex`, `RemoveIndex`, `AddConstraint`, `RemoveConstraint`,
`AlterUniqueTogether`, `RunSQL`, `RunCode`.

```ts
ops.RunSQL({
  sqlite: "UPDATE blog_post SET slug = lower(title)",
  postgresql: "UPDATE blog_post SET slug = lower(title)",   // a dialect without SQL is skipped
  reverse: ops.RunSQL.noop,
})

// Data migration with historical models (the models as they were at this migration)
ops.RunCode(
  async (apps, conn, { using }) => {
    const Post = apps.getModel('blog', 'Post')
    for await (const p of Post.objects.using(using).filter({ slug: '' })) {
      p.slug = slugify(p.title)
      await p.save({ using })
    }
  },
  ops.RunCode.noop,   // reverse
)
```

### How changes are applied

- **SQLite / D1**: `ALTER TABLE … ADD/DROP/RENAME COLUMN` where SQLite allows it; anything else (changing a
  column, unique / NOT NULL / FK columns, check constraints) rebuilds the table like Django, in a D1-safe way
  (`PRAGMA defer_foreign_keys = ON`, stash rows, drop, recreate, copy back, recreate indexes). Data is kept.
- **PostgreSQL**: plain `ALTER TABLE … ALTER COLUMN TYPE / SET NOT NULL / SET DEFAULT`, named unique,
  check and `DEFERRABLE INITIALLY DEFERRED` foreign key constraints.

### D1: local, remote and `wrangler d1 migrations`

```bash
ghuri migrate                         # local D1 (wrangler's local state, via getPlatformProxy)
ghuri migrate --remote                # the production D1 database
ghuri sqlmigrate --all --out migrations-sql     # numbered .sql files for wrangler
wrangler d1 migrations apply DB --remote        # (migrations_dir = "migrations-sql" in wrangler.jsonc)
```

`sqlmigrate --all` writes one file per migration (`0001_blog_0001_initial.sql`, …) in dependency order. Each
file also inserts its `ghuri_migrations` row, so `ghuri showmigrations` agrees with wrangler. Re-running only
adds files for new migrations (existing numbers never change). Pick one way to apply migrations per database.

### Programmatic API

```ts
import { makeMigrations, migrate, showMigrations, sqlMigrate } from '@ghuri/orm/migrations'

await migrate({ using: 'default' })                      // Workers-safe (no file system)
await migrate({ appLabel: 'blog', target: 'zero' })
const sql = await sqlMigrate('blog', '0002', { dialect: 'postgresql' })
const status = await showMigrations()                    // [{ app, name, applied, dependencies }]
await makeMigrations({ dryRun: true })                   // writing files needs @ghuri/orm/commands (Node)
```

`MigrationLoader`, `MigrationExecutor`, `MigrationRecorder`, `MigrationAutodetector`, `MigrationWriter`,
`ProjectState` / `StateApps` and the schema editors are exported from `@ghuri/orm/migrations` too.
`@ghuri/orm/commands` (Node only) exports the command classes (`MakemigrationsCommand`, `MigrateCommand`, …)
and `registerOrmCommands()`, which adds them to core's `commandRegistry`.

## Data: dumpdata, loaddata, copydata, flush

```bash
ghuri dumpdata blog.Post auth --indent 2 -o data.json   # Django-compatible JSON fixtures
ghuri loaddata data.json                                # also: names in <app>/fixtures/, '-' for stdin
ghuri flush --no-input                                  # delete every row (keeps the schema)
ghuri copydata --from default --to pg                   # dump + load in-process between two aliases
```

Fixtures look like Django's: `[{ "model": "blog.post", "pk": 1, "fields": { "author": 3, "tags": [1, 2] } }]`
(FKs as pks, M2M as pk lists, dates ISO strings, binary base64). `loaddata` upserts by pk in dependency order
inside one transaction (one batch on D1), replaces M2M rows and resets PostgreSQL sequences. Every command
takes `--database <alias>` (Django semantics). Programmatic: `dumpData`, `loadData`, `flushDatabase`,
`copyData` from `@ghuri/orm/migrations`.

## Switching D1 → PostgreSQL

Keep both databases configured while moving:

```ts
DATABASES: {
  default: d1('DB'),
  pg: postgres({ url: env.DATABASE_URL }),   // or { hyperdrive: 'HYPERDRIVE' } on Workers
}
```

```bash
ghuri migrate --database pg                      # same migration files, PostgreSQL DDL
ghuri copydata --from default --to pg            # or: dumpdata --database default > data.json
                                                 #     loaddata data.json --database pg
ghuri migrate --remote && ghuri copydata --remote --from default --to pg   # from production D1
```

Then make `pg` the `default` alias. No application code changes: values, lookups, case rules, NULL ordering
(NULLs sort first ascending on every backend) and `onDelete` behave the same.

## Testing

```ts
import { setupTestDatabase } from '@ghuri/orm/testing'

let db
beforeAll(async () => { db = await setupTestDatabase({ using: 'sqlite' }) })   // 'sqlite' | 'pglite' | 'd1'
beforeEach(() => db.flush())
afterAll(() => db.teardown())
```

`setupTestDatabase` creates a fresh in-memory database (D1 through Miniflare), installs a global context (or
merges `DATABASES` into the current one), runs the migrations of installed apps that have some (like Django's
test runner; `postMigrate` is sent) and creates tables directly for every other model (all registered models,
or `models: [...]`; `postMigrate` is sent for them too), and returns `{ connection, flush, teardown }`.
`flush()` deletes every row, resets sequences and sends `postMigrate` for every installed app like `ghuri flush`,
so post-migrate data (e.g. `auth` content types and permissions) is recreated; `flush({ inhibitPostMigrate: true })`
leaves the tables empty. `setTestSchemaCreator(fn)` replaces the schema step. `testBackends()` reads `GHURI_TEST_BACKENDS` for `describe.each`.
`captureQueries(fn)` and `onQuery(listener)` are exported from the main entry (`@ghuri/orm`, not
`@ghuri/orm/testing`); `captureQueries` returns the block's result and the SQL statements it executed:

```ts
import { captureQueries } from '@ghuri/orm'

const [posts, queries] = await captureQueries(async () => await Post.objects.selectRelated('author'))
expect(queries).toHaveLength(1)   // queries[i]: { alias, vendor, sql, params, durationMs }
```

## Escape hatches

```ts
import { getDrizzle } from '@ghuri/orm'
const db = await getDrizzle()
const rows = await db.select().from(Post.table())   // values converted like the ORM's
await (await connections.get()).execute('SELECT 1')
Post.objects.filter(...).toSQL()                     // { sql, params }
```

## Differences from Django

- Everything touching the database is `async`; related objects are awaited (`await post.author`).
- Deferred fields (`only()` / `defer()`) are `undefined` until `refreshFromDb({ fields })`.
- `inBulk()` returns a `Map`; `delete()` returns `[total, perModel]`.
- Default reverse accessor `postSet` (camelCase) and lookup name `post`.
- Filters on multi-valued relations use `EXISTS` (no duplicate rows, `distinct()` rarely needed).
- `DecimalField` values are strings; SQLite stores them with NUMERIC affinity (≤ 15 significant digits).
- `DurationField` is milliseconds (number).
- Migrations: `RunCode` instead of `RunPython`; the one-off default is stored on the operation
  (`oneOffDefault`) instead of `preserve_default=False`; index names are always explicit in migration files;
  swappable models (`settings.AUTH_USER_MODEL` dependencies) are written as plain labels.
