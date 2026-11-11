import { GhuriError } from '@ghuri/core'

/** Base class of migration errors. */
export class MigrationError extends GhuriError {}

/** A migration (or a dependency) can't be found. */
export class NodeNotFoundError extends MigrationError {}

/** Applied migrations have unapplied dependencies. */
export class InconsistentMigrationHistory extends MigrationError {}

/** An operation (or migration) can't be unapplied. */
export class IrreversibleError extends MigrationError {}

/** The requested plan can't be executed (ambiguous target, circular dependency, …). */
export class InvalidMigrationPlan extends MigrationError {}

/** Several leaf migrations in one app (fix with `makemigrations --merge`). */
export class MigrationConflictError extends MigrationError {}

/** makemigrations needs an answer it can't get non-interactively. */
export class MigrationQuestionError extends MigrationError {}
