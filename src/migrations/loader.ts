import { type AppConfig, apps } from '@ghuri/core'
import type { Connection } from '../db/types'
import { isModelClass } from '../models/registry'
import type { ModelClass } from '../models/types'
import { globalSingleton, isPlainObject } from '../utils'
import { InconsistentMigrationHistory, InvalidMigrationPlan, NodeNotFoundError } from './errors'
import { keyOf, MigrationGraph } from './graph'
import { isMigration, type Migration, type MigrationKey } from './migration'
import { type AppliedMigration, MigrationRecorder } from './recorder'
import { ProjectState } from './state'

/** Loads an app's migrations from somewhere else than `AppConfig.migrations` (the Node disk loader). */
export type MigrationSourceLoader = (config: AppConfig) => Promise<Map<string, Migration> | null>

const hooks = globalSingleton<{ disk?: MigrationSourceLoader }>(
  'ghuri.orm.migrations.sourceHooks',
  () => ({}),
)

/** Installed by `@ghuri/orm/commands` (Node): read `<AppConfig.path>/migrations/*.ts` from disk. */
export function setMigrationDiskLoader(fn: MigrationSourceLoader | undefined): void {
  hooks.disk = fn
}

export function getMigrationDiskLoader(): MigrationSourceLoader | undefined {
  return hooks.disk
}

/**
 * Migrations exported by an app's `migrations/index.ts`: `export { m0001_initial, … }` and/or
 * `export const migrations = { '0001_initial': … }` (also accepts a plain `{ name: Migration }` map).
 * Returns null when the app has no migrations module.
 */
export function migrationsFromModule(mod: unknown): Map<string, Migration> | null {
  if (mod === undefined || mod === null) return null
  const out = new Map<string, Migration>()
  const seen = new Set<Migration>()
  const add = (name: string, m: Migration) => {
    if (seen.has(m)) return
    seen.add(m)
    const n = m.name || name.replace(/^m(?=\d)/, '')
    out.set(n, m)
  }
  const visit = (obj: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if (isMigration(v)) add(k, v)
      else if (depth === 0 && (isPlainObject(v) || (v && typeof v === 'object' && k === 'migrations')))
        visit(v as Record<string, unknown>, 1)
    }
  }
  if (typeof mod === 'object') visit(mod as Record<string, unknown>, 0)
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

export interface MigrationLoaderOptions {
  /** Read applied migrations from this connection (omit for none). */
  connection?: Connection | null
  /** `'auto'` (default): disk when a disk loader is installed and `AppConfig.path` has a migrations dir. */
  source?: 'auto' | 'modules' | 'disk'
  /** Use squashed migrations in place of the ones they replace when possible (default true). */
  replaceMigrations?: boolean
  /** App configs to load (default: every installed app). */
  appConfigs?: AppConfig[]
}

/**
 * Loads migrations of the installed apps and builds the dependency graph (Django's `MigrationLoader`).
 * Apps with a migrations module are "migrated"; others are "unmigrated" and their live models form the
 * base state.
 */
export class MigrationLoader {
  readonly graph = new MigrationGraph()
  /** Every loaded migration keyed by `app.name`. */
  readonly migrations = new Map<string, Migration>()
  readonly migratedApps = new Set<string>()
  readonly unmigratedApps = new Set<string>()
  /** Applied migrations keyed by `app.name` (empty without a connection). */
  applied = new Map<string, AppliedMigration>()
  /** Squashed migrations in use → keys they replace. */
  readonly replacements = new Map<string, MigrationKey[]>()
  readonly appConfigs: AppConfig[]

  private constructor(private readonly opts: MigrationLoaderOptions) {
    this.appConfigs = opts.appConfigs ?? apps.getAppConfigs()
  }

  static async load(opts: MigrationLoaderOptions = {}): Promise<MigrationLoader> {
    const loader = new MigrationLoader(opts)
    await loader.build()
    return loader
  }

  /** Reload everything (after makemigrations wrote files, or migrate changed applied rows). */
  async build(): Promise<void> {
    this.migrations.clear()
    this.migratedApps.clear()
    this.unmigratedApps.clear()
    this.replacements.clear()
    for (const k of [...this.graph.keys.values()]) this.graph.removeNode(k)
    await this.loadMigrations()
    if (this.opts.connection)
      this.applied = await new MigrationRecorder(this.opts.connection).appliedMigrations()
    else this.applied = new Map()
    this.buildGraph()
  }

  private async loadMigrations(): Promise<void> {
    const source = this.opts.source ?? 'auto'
    for (const config of this.appConfigs) {
      const label = config.appLabel
      let found: Map<string, Migration> | null = null
      if (source !== 'modules' && hooks.disk && config.path) found = await hooks.disk(config)
      if (!found && source !== 'disk') found = migrationsFromModule(config.migrations)
      if (!found) {
        this.unmigratedApps.add(label)
        continue
      }
      this.migratedApps.add(label)
      for (const [name, m] of found) {
        m.appLabel = label
        m.name = name
        this.migrations.set(`${label}.${name}`, m)
      }
    }
  }

  private resolveDependency(origin: Migration, dep: readonly [string, string]): MigrationKey | null {
    const [app, name] = dep
    if (name === '__first__' || name === '__latest__') {
      if (this.unmigratedApps.has(app) || !this.migratedApps.has(app)) {
        if (this.unmigratedApps.has(app)) return null
        throw new NodeNotFoundError(`Migration ${origin} depends on app '${app}' which isn't installed.`)
      }
      const nodes = [...this.migrations.values()].filter((m) => m.appLabel === app)
      if (!nodes.length) return null
      const g = new MigrationGraph()
      for (const m of nodes) g.addNode(m.key, m)
      for (const m of nodes)
        for (const d of m.dependencies) if (d[0] === app && g.has(d)) g.addDependency(String(m), m.key, d)
      const pick = name === '__first__' ? g.rootNodes(app) : g.leafNodes(app)
      return pick[0] ?? null
    }
    if (!this.migrations.has(`${app}.${name}`)) {
      throw new NodeNotFoundError(
        `Migration ${origin} dependencies reference nonexistent parent node ('${app}', '${name}').`,
      )
    }
    return [app, name]
  }

  private buildGraph(): void {
    for (const m of this.migrations.values()) this.graph.addNode(m.key, m)
    for (const m of this.migrations.values()) {
      for (const dep of m.dependencies) {
        const parent = this.resolveDependency(m, dep)
        if (parent) this.graph.addDependency(String(m), m.key, parent)
      }
      for (const rb of m.runBefore) {
        if (this.migrations.has(`${rb[0]}.${rb[1]}`)) this.graph.addDependency(String(m), rb, m.key)
      }
    }
    if (this.opts.replaceMigrations !== false) {
      for (const m of this.migrations.values()) {
        if (!m.replaces.length) continue
        const replaced = m.replaces.filter((r) => this.graph.has(r))
        const status = m.replaces.map((r) => this.applied.has(keyOf(r)))
        const allApplied = status.every(Boolean)
        const noneApplied = !status.some(Boolean)
        if (allApplied || noneApplied) {
          if (allApplied && !this.applied.has(keyOf(m.key))) {
            const last = this.applied.get(keyOf(m.replaces[m.replaces.length - 1]))!
            this.applied.set(keyOf(m.key), { ...last, app: m.appLabel, name: m.name })
          }
          this.graph.remapReplaced(m.key, replaced)
          for (const r of replaced) this.migrations.delete(keyOf(r))
          this.replacements.set(keyOf(m.key), replaced)
        } else {
          // Partially applied: keep the original migrations, drop the squashed one.
          const last = replaced[replaced.length - 1]
          const k = keyOf(m.key)
          for (const child of [...(this.graph.children.get(k) ?? [])]) {
            const ck = this.graph.keys.get(child)!
            if (last) this.graph.addDependency(String(m), ck, last)
          }
          this.graph.removeNode(m.key)
          this.migrations.delete(k)
        }
      }
    } else {
      for (const m of [...this.migrations.values()]) {
        if (m.replaces.length) {
          this.graph.removeNode(m.key)
          this.migrations.delete(keyOf(m.key))
        }
      }
    }
    this.graph.ensureNotCyclic()
  }

  /** Raise if an applied migration has unapplied dependencies. */
  checkConsistentHistory(): void {
    for (const k of this.applied.keys()) {
      if (!this.graph.nodes.has(k)) continue
      const key = this.graph.keys.get(k)!
      for (const p of this.graph.parents.get(k) ?? []) {
        if (!this.applied.has(p)) {
          throw new InconsistentMigrationHistory(
            `Migration ${keyOf(key)} is applied before its dependency ${p} on the database.`,
          )
        }
      }
    }
  }

  /** `{ app: [leaf names] }` for apps with more than one leaf migration. */
  detectConflicts(): Record<string, string[]> {
    const byApp = new Map<string, string[]>()
    for (const [app, name] of this.graph.leafNodes()) {
      const list = byApp.get(app) ?? []
      list.push(name)
      byApp.set(app, list)
    }
    const out: Record<string, string[]> = {}
    for (const [app, names] of byApp) if (names.length > 1) out[app] = names.sort()
    return out
  }

  getMigration(app: string, name: string): Migration {
    const m = this.migrations.get(`${app}.${name}`) ?? this.graph.nodes.get(`${app}.${name}`)
    if (!m) throw new NodeNotFoundError(`Cannot find a migration matching '${name}' from app '${app}'.`)
    return m
  }

  /** Migration of `app` whose name starts with `prefix` (unique). */
  getMigrationByPrefix(app: string, prefix: string): Migration {
    const exact = this.migrations.get(`${app}.${prefix}`)
    if (exact) return exact
    const hits = [...this.migrations.values()].filter((m) => m.appLabel === app && m.name.startsWith(prefix))
    if (hits.length > 1)
      throw new InvalidMigrationPlan(
        `More than one migration matches '${prefix}' in app '${app}'. Please be more specific.`,
      )
    if (!hits.length)
      throw new NodeNotFoundError(`Cannot find a migration matching '${prefix}' from app '${app}'.`)
    return hits[0]
  }

  /** Live models of apps without migrations (part of every project state). */
  unmigratedModels(): ModelClass[] {
    return (apps.getModels() as unknown[]).filter(
      (m): m is ModelClass => isModelClass(m) && this.unmigratedApps.has(m._meta.appLabel),
    )
  }

  /** Project state after `nodes` (default: every leaf), including unmigrated apps' live models. */
  projectState(nodes?: MigrationKey | MigrationKey[], atEnd = true): ProjectState {
    const base = ProjectState.fromModels(this.unmigratedModels())
    for (const a of this.unmigratedApps) base.realApps.add(a)
    return this.graph.makeState(nodes, { atEnd, base })
  }
}
