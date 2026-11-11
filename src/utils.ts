/** `createdAt` → `created_at`, `userID` → `user_id`, `HTMLParser` → `html_parser`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

/** `createdAt` → `created at` (Django's verbose name from attribute name). */
export function humanize(name: string): string {
  return snakeCase(name).replace(/_/g, ' ').trim()
}

export function capfirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

export function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

/** Small deterministic hash (FNV-1a, 32-bit) used for index/constraint names. */
export function shortHash(...parts: string[]): string {
  let h = 0x811c9dc5
  for (const ch of parts.join('\u0000')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length <= size) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export const LOOKUP_SEP = '__'

/** Global singletons survive duplicate module instances (like @ghuri/core does). */
export function globalSingleton<T>(key: string, create: () => T): T {
  const g = globalThis as any
  const sym = Symbol.for(key)
  if (!(sym in g)) g[sym] = create()
  return g[sym] as T
}
