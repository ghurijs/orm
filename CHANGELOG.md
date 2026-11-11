# Changelog

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
