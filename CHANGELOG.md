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
