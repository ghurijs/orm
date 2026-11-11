import type { Field, FieldOptions } from './base'
import { ForeignKey, ManyToManyField, OneToOneField, SET } from './related'
import * as scalar from './scalar'

export * from './base'
export * from './related'
export * from './scalar'

type FieldCtor = new (...args: any[]) => Field<any, any>

const fieldClasses = new Map<string, FieldCtor>()
for (const cls of [...Object.values(scalar), ForeignKey, OneToOneField, ManyToManyField]) {
  if (typeof cls === 'function' && 'internalType' in cls)
    fieldClasses.set((cls as any).internalType, cls as FieldCtor)
}

/** Register a custom field class so migrations can rebuild it from `deconstruct()` output. */
export function registerFieldClass(cls: FieldCtor & { internalType: string }): void {
  fieldClasses.set(cls.internalType, cls)
}

export function getFieldClass(type: string): FieldCtor | undefined {
  return fieldClasses.get(type)
}

/**
 * Rebuild a field from a migration spec (`{ type: 'CharField', maxLength: 200 }`) or a deconstruction
 * (`{ type, options }`). Relation targets stay as `'app.Model'` strings (resolved lazily).
 */
export function fieldFromSpec(
  spec: { type: string; options?: Record<string, unknown> } & Record<string, unknown>,
): Field<any, any> {
  const { type, options: nested, ...flat } = spec
  const options: Record<string, any> = { ...(nested ?? {}), ...flat }
  const cls = fieldClasses.get(type)
  if (!cls) throw new TypeError(`Unknown field type '${type}' (register it with registerFieldClass()).`)
  delete options.validators
  if (options.default && typeof options.default === 'object' && 'callable' in options.default)
    delete options.default
  if (type === 'ForeignKey' || type === 'OneToOneField' || type === 'ManyToManyField') {
    const { to, onDelete, onDeleteValue, ...rest } = options
    if (type === 'ManyToManyField') return new cls(to, rest as FieldOptions)
    const od = onDelete === 'SET' ? SET(onDeleteValue) : (onDelete ?? 'CASCADE')
    return new cls(to, { ...rest, onDelete: od })
  }
  return new cls(options)
}
