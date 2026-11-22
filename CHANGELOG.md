# Changelog

## Unreleased

- fix: a cascading delete no longer fails on D1 when rows it deletes point at each other through `SET_NULL`,
  `SET_DEFAULT` or `SET()` (for example deleting a tenant whose entries point at its parties). D1 commits every
  statement on its own, so a deferred foreign key is checked right after each `DELETE`, and the collector could
  delete the parties before the entries. Those links now count when ordering the deletes (unless they would
  contradict a `CASCADE` link or form a loop); a row being deleted is nulled first, as Django does, whenever its
  table isn't deleted before the row it points at.

## 0.1.0-alpha.5

- Swappable models (Django's `Meta.swappable`): `static Meta = { swappable: 'SETTING' }` (a dotted name reads a
  nested setting, `'AGENTS.CONVERSATION_MODEL'`). When the setting names another model, `_meta.swapped` returns
  that label and the model is not installed: it is left out of `apps.getModels()`, the autodetector and test
  databases, its relations are not reverse relations of their targets, and its managers throw `Manager isn't
  available; '<label>' has been swapped for '<other>'`. Nothing changes while the setting is unset or names the
  model itself. New: `getSwappableModel(setting, default?)`, `getSwappableLabel()`, `readSwappableSetting()`.
- Swappable markers for migrations (Django's `to=settings.X` / `swappable_dependency()`), from
  `@ghuri/orm/migrations`: `swappableModel(setting, default?)` as a field's `to`, read as the label the setting
  names when the migration runs, and `swappableDependency(setting, default?)`, which depends on the migration
  creating that model (else the app's first; ignored for the migration's own app; `__first__` when the creating
  migration depends on this one; never an inconsistent history for an applied migration). The loader skips a
  swapped model's operations (`CreateModel` with `options.swappable` and later operations on it).
  `makemigrations` writes `swappableModel()` / `swappableDependency()` for relations to a model named by a
  swappable setting (for example `auth.User`) and records `swappable` in `CreateModel` options; existing migration
  files are unchanged and still load. Also exported: `SwappableReference`, `isSwappableReference()`,
  `swappableDependencyInfo()`, `withoutSwappedModels()`.

## 0.1.0-alpha.4

- fix: concurrent `atomic()` blocks on one SQLite (better-sqlite3) or PGlite connection no longer fail with
  `cannot start a transaction within a transaction` (SQLite) or silently share one transaction (PGlite: a
  rollback in one block undid the other's writes). These backends share one connection per process, so each
  connection now has a FIFO lock: an outermost transaction (`atomic()`, `connection.transaction()`,
  `connection.batch()`) holds it until COMMIT/ROLLBACK and concurrent ones queue. Nested `atomic()` and other
  code in the block's own async context keep using the transaction (savepoints) without waiting.
- fix: on SQLite and PGlite, queries outside `atomic()` from another async context wait for an open
  transaction instead of running inside it (they saw its uncommitted rows, and its rollback discarded their
  writes). PostgreSQL (postgres.js, a pooled connection per transaction) and D1 (no interactive transactions)
  are unchanged.
- docs: the README's Testing section says `captureQueries` is imported from `@ghuri/orm` (it was described
  under `@ghuri/orm/testing`); new README notes on transaction concurrency for SQLite / PGlite.

## 0.1.0-alpha.3

- Managers follow JavaScript shadowing: a property of a more-derived class (for example a getter that returns a
  manager) hides a parent's manager of the same name, instead of the parent's manager being bound over it.

## 0.1.0-alpha.2

- `none()` used as a subquery (`filter({ author__in: Author.objects.none() })`) matched every row because the compiler ignored `isNone`; it now matches nothing, also in `update()` / fast `delete()` paths that compile a primary-key subquery.

## 0.1.0-alpha.1

- fix(testing): `setupTestDatabase({ using: "d1" })` works with Miniflare 5 (pinned by wrangler 4.160+) by converting v4-style options with `convertV4MiniflareOptions` when available.
- Testing: `TestDatabase.flush()` sends `postMigrate` for every installed app after deleting the rows (like `ghuri flush`), so post-migrate data such as `auth` permissions is recreated; `flush({ inhibitPostMigrate: true })` opts out. `setupTestDatabase()` also sends `postMigrate` when no installed app has migrations. New `emitPostMigrate(using)` export.
- `makemigrations <app>` writes the initial migration of an app that has no `migrations/` directory (the app's live models were left in the old state, so nothing was detected).
- Historical states ignore unresolved relations of unmigrated apps (e.g. a test app's ForeignKey to `auth.User` while `auth`'s first migration is applied) instead of failing `migrate`.
- `pglite({ dataDir })` creates the data directory (and parents) on first connect.

## 0.1.0-alpha.0 (unreleased)

- Models: `Model({...})` factory with inferred instance types, `BaseModel`, `_meta` (Options), abstract models,
  app label assignment through `apps.onPopulate`, lazy relation targets.
- Fields of ARCHITECTURE §5.2 with validators, `deconstruct()`, `formHint()`, `jsonSchema()` and portable
  value conversion (SQLite/D1 and PostgreSQL).
- QuerySet / Manager: lazy, immutable, thenable; all lookups and date transforms, `Q`, `F`, aggregates,
  annotations with GROUP BY via `values()`, select/prefetch related, bulk operations.
- Relations: FK / one-to-one / M2M accessors and related managers, ORM-emulated `onDelete`, signals.
- Adapters: `d1()`, `postgres()` (main entry), `sqlite()` (`/sqlite`), `pglite()` (`/pglite`); `atomic()`,
  `onCommit()`, `connections`, `getDrizzle()`, drizzle tables per dialect.
- Schema editors for SQLite and PostgreSQL (`/migrations`); `setupTestDatabase()` (`/testing`) for SQLite,
  PGlite and D1 (Miniflare); `getObjectOr404()`.
- Migrations (`@ghuri/orm/migrations`): `Migration`, `operations` (`CreateModel`, `DeleteModel`, `RenameModel`,
  `AlterModelTable`, `AlterModelOptions`, `AddField`, `RemoveField`, `AlterField`, `RenameField`, `AddIndex`,
  `RemoveIndex`, `AddConstraint`, `RemoveConstraint`, `AlterUniqueTogether`, `RunSQL`, `RunCode`),
  `ProjectState` / `StateApps` historical models, `MigrationLoader` (AppConfig.migrations modules or files on
  disk, cross-app dependencies, `__first__` / `__latest__`, squashed migrations, conflict detection),
  `MigrationExecutor` (targets, `fake`, `fakeInitial`, atomic per migration: transaction or one D1 batch),
  `MigrationRecorder` (`ghuri_migrations`), `MigrationAutodetector` with interactive / non-interactive
  questioners, `MigrationWriter` (formatted TypeScript + `migrations/index.ts`).
- Schema editors: `addField` / `removeField` / `alterField` / `renameField` / `renameModel` /
  `alterUniqueTogether`, SQLite table rebuild that keeps data and works on D1, check constraints on SQLite,
  PostgreSQL ALTERs (type, null, default, unique, FK, index, check).
- Programmatic API: `makeMigrations`, `migrate`, `showMigrations`, `sqlMigrate`, `sqlMigrateAll`; data API:
  `dumpData`, `loadData`, `flushDatabase`, `copyData`.
- `@ghuri/orm/commands` (Node): `makemigrations`, `migrate`, `showmigrations`, `sqlmigrate` (incl. `--all
  --out` for `wrangler d1 migrations apply`), `dumpdata`, `loaddata`, `copydata`, `flush`;
  `registerOrmCommands()`.
- `preMigrate` / `postMigrate` signals (main entry).
- `setupTestDatabase()` runs app migrations when present (`migrateOrCreateTables`), else creates tables.
