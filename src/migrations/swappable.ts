// Swappable models in migrations (Django's `swappable_dependency(settings.X)` and `to=settings.X`). Migration files
// of reusable apps name a swappable model through its setting, so they work whichever model the project uses:
//
//   dependencies: [swappableDependency('AUTH_USER_MODEL', 'auth.User')],
//   fields: { user: { type: 'ForeignKey', to: swappableModel('AUTH_USER_MODEL', 'auth.User'), onDelete: 'CASCADE' } }
//
// Both resolve lazily against the current settings. The loader also drops the operations of a model that is
// swapped out (its `CreateModel` carries `options.swappable`), so it gets no table.

import { modelRegistry } from '../models/registry'
import { getSwappableLabel, readSwappableSetting } from '../models/swappable'
import type { ModelClass } from '../models/types'
import { Migration } from './migration'
import type { Operation } from './operations'

const DEPENDENCY = Symbol.for('ghuri.orm.migrations.swappableDependency')
const REFERENCE = Symbol.for('ghuri.orm.migrations.swappableModel')

/** The setting (and fallback label) behind a swappable marker. */
export interface SwappableInfo {
  setting: string
  defaultLabel?: string
}

/**
 * A dependency on the first migration of the app that holds the model a swappable setting names (Django's
 * `swappable_dependency`): `swappableDependency('AUTH_USER_MODEL', 'auth.User')` is `['auth', '__first__']` by
 * default and `['accounts', '__first__']` with `AUTH_USER_MODEL: 'accounts.User'`. The app label is read when the
 * loader resolves dependencies, not when the migration file is imported. A dependency on the migration's own app
 * is ignored.
 */
export function swappableDependency(setting: string, defaultLabel?: string): readonly [string, string] {
  const dep: string[] = ['', '__first__']
  Object.defineProperty(dep, 0, {
    get: () => getSwappableLabel(setting, defaultLabel).split('.')[0],
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(dep, DEPENDENCY, { value: { setting, defaultLabel } satisfies SwappableInfo })
  return dep as unknown as readonly [string, string]
}

/** The marker behind a `swappableDependency()`, if `dep` is one. */
export function swappableDependencyInfo(dep: unknown): SwappableInfo | undefined {
  return Array.isArray(dep) ? ((dep as any)[DEPENDENCY] as SwappableInfo | undefined) : undefined
}

/** A relation target named by a swappable setting (`to: swappableModel('AUTH_USER_MODEL', 'auth.User')`). */
export class SwappableReference implements SwappableInfo {
  constructor(
    readonly setting: string,
    readonly defaultLabel?: string,
  ) {}

  /** The `'app_label.ModelName'` the setting names now. */
  resolve(): string {
    return getSwappableLabel(this.setting, this.defaultLabel)
  }

  toString(): string {
    return this.resolve()
  }
}

/**
 * The relation target of a migration field spec, named by a swappable setting (Django's `to=settings.X`):
 * `to: swappableModel('AGENTS.CONVERSATION_MODEL', 'agents.Conversation')`. Operations read it as the label the
 * setting names now.
 */
export function swappableModel(setting: string, defaultLabel?: string): SwappableReference {
  return new SwappableReference(setting, defaultLabel)
}

export function isSwappableReference(v: unknown): v is SwappableReference {
  return v instanceof SwappableReference || (!!v && typeof v === 'object' && (v as any)[REFERENCE] === true)
}
;(SwappableReference.prototype as any)[REFERENCE] = true

/**
 * Store `ref` as `options[key]`: a getter returning the label it names now (so every reader sees a string),
 * which remembers the reference for the migration writer.
 */
export function defineSwappableOption(
  options: Record<string, unknown>,
  key: string,
  ref: SwappableReference,
): void {
  const get = () => ref.resolve()
  ;(get as any)[REFERENCE] = ref
  Object.defineProperty(options, key, { get, enumerable: true, configurable: true })
}

/** The reference stored by `defineSwappableOption`, if `options[key]` is one. */
export function swappableOptionOf(options: object, key: string): SwappableReference | undefined {
  const get = Object.getOwnPropertyDescriptor(options, key)?.get as any
  return get?.[REFERENCE]
}

// ---- loader -------------------------------------------------------------------------------------

/** Operations whose `name` is the model's name. */
const MODEL_OPERATIONS = new Set([
  'CreateModel',
  'DeleteModel',
  'AlterModelTable',
  'AlterModelOptions',
  'AlterUniqueTogether',
])

/** Name of the model an operation works on (`CreateModel.name`, `AddField.modelName`, `RenameModel.oldName`). */
function operationModel(op: Operation): string | undefined {
  const o = op as unknown as { modelName?: unknown; oldName?: unknown; name?: unknown }
  const model = o.modelName ?? o.oldName ?? (MODEL_OPERATIONS.has(op.type) ? o.name : undefined)
  return typeof model === 'string' ? model.toLowerCase() : undefined
}

/**
 * Models of `appLabel` swapped out by their setting: those whose `CreateModel` has `options.swappable` and whose
 * setting names another model.
 */
function swappedModelNames(appLabel: string, migrations: Iterable<Migration>): Set<string> {
  const out = new Set<string>()
  for (const m of migrations) {
    for (const op of m.operations) {
      if (op.type !== 'CreateModel') continue
      const { name, options } = op as unknown as { name: string; options: Record<string, unknown> }
      const setting = options.swappable
      if (typeof setting !== 'string' || !setting) continue
      const value = readSwappableSetting(setting)
      if (typeof value === 'string' && value && value.toLowerCase() !== `${appLabel}.${name}`.toLowerCase())
        out.add(name.toLowerCase())
    }
  }
  return out
}

/**
 * An app's migrations with the operations of its swapped-out models removed (Django skips their tables the same
 * way). Returns `migrations` itself when nothing of this app is swapped.
 */
export function withoutSwappedModels(
  appLabel: string,
  migrations: Map<string, Migration>,
): Map<string, Migration> {
  const swapped = swappedModelNames(appLabel, migrations.values())
  if (!swapped.size) return migrations
  const out = new Map<string, Migration>()
  for (const [name, m] of migrations) {
    const operations = m.operations.filter((op) => {
      const model = operationModel(op)
      return model === undefined || !swapped.has(model)
    })
    if (operations.length === m.operations.length) {
      out.set(name, m)
      continue
    }
    const adapted = new Migration({
      dependencies: m.dependencies,
      operations,
      replaces: m.replaces,
      initial: m.initial,
      atomic: m.atomic,
      runBefore: m.runBefore,
    })
    adapted.appLabel = m.appLabel
    adapted.name = m.name
    out.set(name, adapted)
  }
  return out
}

// ---- autodetector -------------------------------------------------------------------------------

interface SwappableTarget extends SwappableInfo {
  app: string
}

/** Every swappable setting known from the prepared models, by the lower-case label it names now. */
function swappableTargets(): Map<string, SwappableTarget> {
  const out = new Map<string, SwappableTarget>()
  const declared = new Map<string, ModelClass>()
  for (const m of modelRegistry.all) {
    const setting = m._meta.meta.swappable
    if (typeof setting === 'string' && setting && !declared.has(setting)) declared.set(setting, m)
  }
  for (const [setting, model] of declared) {
    const defaultLabel = model._meta.hasAppLabel ? model._meta.label : undefined
    let label: string
    try {
      label = getSwappableLabel(setting, defaultLabel)
    } catch {
      continue
    }
    if (!label.includes('.')) continue
    out.set(label.toLowerCase(), { setting, defaultLabel, app: label.split('.')[0] })
  }
  return out
}

type FieldSpecLike = { type: string; options: Record<string, unknown> }

function fieldSpecsOf(op: Operation): FieldSpecLike[] {
  const o = op as unknown as { fields?: Record<string, FieldSpecLike>; field?: FieldSpecLike }
  if (op.type === 'CreateModel' && o.fields) return Object.values(o.fields)
  if ((op.type === 'AddField' || op.type === 'AlterField') && o.field) return [o.field]
  return []
}

function absoluteLabel(to: string, appLabel: string): string {
  return (to.includes('.') ? to : `${appLabel}.${to}`).toLowerCase()
}

/**
 * Write relations to swappable models of freshly generated migrations as `swappableModel()` and their app
 * dependency as `swappableDependency()` (what Django's autodetector does with `settings.AUTH_USER_MODEL`).
 */
export function useSwappableReferences(migrations: Map<string, Migration[]>): void {
  const targets = swappableTargets()
  if (!targets.size) return
  for (const [app, list] of migrations) {
    for (const m of list) {
      const markedApps = new Map<string, SwappableTarget>()
      const otherApps = new Set<string>()
      for (const op of m.operations) {
        for (const spec of fieldSpecsOf(op)) {
          const to = spec.options.to
          if (typeof to === 'string' && to !== 'self' && !swappableOptionOf(spec.options, 'to')) {
            const target = targets.get(absoluteLabel(to, app))
            if (target) {
              defineSwappableOption(spec.options, 'to', swappableModel(target.setting, target.defaultLabel))
              markedApps.set(target.app, target)
            } else otherApps.add(absoluteLabel(to, app).split('.')[0])
          }
          const through = spec.options.through
          if (typeof through === 'string') otherApps.add(absoluteLabel(through, app).split('.')[0])
        }
      }
      if (!markedApps.size) continue
      const settings = new Set<string>()
      m.dependencies = m.dependencies.map((d) => {
        const info = swappableDependencyInfo(d)
        if (info) settings.add(info.setting)
        const target = markedApps.get(d[0])
        if (info || !target || d[0] === app || otherApps.has(d[0])) return d
        settings.add(target.setting)
        return swappableDependency(target.setting, target.defaultLabel)
      })
      // Also depend on the swapped-in model when other relations already need the default app.
      for (const [targetApp, target] of markedApps)
        if (targetApp !== app && !settings.has(target.setting)) {
          settings.add(target.setting)
          m.dependencies.push(swappableDependency(target.setting, target.defaultLabel))
        }
    }
  }
}
