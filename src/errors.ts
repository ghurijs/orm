import { GhuriError } from '@ghuri/core'

/** A lookup, field name or expression is invalid (Django's FieldError). */
export class FieldError extends GhuriError {}

/** `_meta.getField()` was asked for a field that doesn't exist (Django's FieldDoesNotExist). */
export class FieldDoesNotExist extends FieldError {}

/** Base class for errors raised by database drivers, normalized across backends. */
export class DatabaseError extends GhuriError {
  sql?: string
  constructor(message: string, options?: { cause?: unknown; sql?: string }) {
    super(message, options)
    this.sql = options?.sql
  }
}

/** Unique / foreign key / not-null / check constraint violation. */
export class IntegrityError extends DatabaseError {}

/** Operation not supported by the current backend (e.g. regex lookups on D1). */
export class NotSupportedError extends DatabaseError {}

/** Misuse of `atomic()` / transactions. */
export class TransactionManagementError extends GhuriError {}

/** Deleting an object that is referenced through a `PROTECT` foreign key. */
export class ProtectedError extends GhuriError {
  constructor(
    message: string,
    readonly protectedObjects: unknown[],
  ) {
    super(message)
  }
}

/** Deleting an object that is referenced through a `RESTRICT` foreign key. */
export class RestrictedError extends GhuriError {
  constructor(
    message: string,
    readonly restrictedObjects: unknown[],
  ) {
    super(message)
  }
}

const INTEGRITY_PATTERNS = [
  /UNIQUE constraint failed/i,
  /FOREIGN KEY constraint failed/i,
  /NOT NULL constraint failed/i,
  /CHECK constraint failed/i,
  /duplicate key value violates unique constraint/i,
  /violates foreign key constraint/i,
  /violates not-null constraint/i,
  /violates check constraint/i,
]
const INTEGRITY_CODES = new Set(['23505', '23503', '23502', '23514', '23000'])

/** Map a driver error to `IntegrityError` / `DatabaseError` (keeps the original as `cause`). */
export function wrapDatabaseError(err: unknown, sql?: string): Error {
  if (err instanceof DatabaseError) return err
  const e = err as { message?: string; code?: string }
  const message = String(e?.message ?? err)
  const code = String(e?.code ?? '')
  if (
    INTEGRITY_CODES.has(code) ||
    code.startsWith('SQLITE_CONSTRAINT') ||
    INTEGRITY_PATTERNS.some((p) => p.test(message))
  ) {
    return new IntegrityError(message, { cause: err, sql })
  }
  return new DatabaseError(message, { cause: err, sql })
}
