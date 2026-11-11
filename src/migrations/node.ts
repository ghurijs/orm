// Node-only helpers for migrations: read migration files from disk, write generated files.
// Imported by `@ghuri/orm/commands` only (never by the Workers-safe entries).
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppConfig } from '@ghuri/core'
import { MIGRATION_FILE, type MigrationFileSystem, setMigrationFileSystem } from './api'
import { setMigrationDiskLoader } from './loader'
import { isMigration, type Migration } from './migration'

type Importer = (file: string) => Promise<unknown>

let importer: Importer = (file) => import(pathToFileURL(file).href)

/**
 * How migration files are imported (default: native `import()`, which runs `.ts` on Node ≥ 22.6 with type
 * stripping). The CLI sets this to its TypeScript loader (jiti).
 */
export function setMigrationImporter(fn: Importer): void {
  importer = fn
}

/** Migrations in `<config.path>/migrations` (`NNNN_name.ts` files), or null when the directory is missing. */
export async function loadMigrationsFromDisk(config: AppConfig): Promise<Map<string, Migration> | null> {
  if (!config.path) return null
  const dir = join(config.path, 'migrations')
  if (!existsSync(dir)) return null
  const names = new Map<string, string>()
  for (const f of (await readdir(dir)).sort()) {
    if (f.endsWith('.d.ts')) continue
    const m = f.match(MIGRATION_FILE)
    if (m && !names.has(m[1])) names.set(m[1], join(dir, f))
  }
  const out = new Map<string, Migration>()
  for (const [name, file] of names) {
    const mod = (await importer(file)) as Record<string, unknown>
    const migration = isMigration(mod?.default)
      ? mod.default
      : (Object.values(mod ?? {}).find((v) => isMigration(v)) as Migration | undefined)
    if (!migration) throw new Error(`Migration file ${file} has no default export of a Migration.`)
    out.set(name, migration)
  }
  return out
}

export const nodeMigrationFileSystem: MigrationFileSystem = {
  async writeFile(path, content) {
    await writeFile(path, content, 'utf8')
  },
  async readFile(path) {
    return readFile(path, 'utf8')
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },
  async readdir(path) {
    return existsSync(path) ? readdir(path) : []
  },
  async exists(path) {
    return existsSync(path)
  },
  join: (...parts) => join(...parts),
  relative(path) {
    if (!isAbsolute(path)) return path
    const rel = relative(process.cwd(), path)
    return rel.startsWith('..') ? path : rel
  },
}

/** Install the disk loader and file system hooks (done when `@ghuri/orm/commands` is imported). */
export function installNodeMigrationHooks(): void {
  setMigrationDiskLoader(loadMigrationsFromDisk)
  setMigrationFileSystem(nodeMigrationFileSystem)
}
