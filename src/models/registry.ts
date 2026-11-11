import { apps, ImproperlyConfigured, LookupError } from '@ghuri/core'
import type { RelatedField } from '../fields/related'
import { globalSingleton } from '../utils'
import type { ModelClass } from './types'

/** Static marker shared by every Model class, even across duplicate module instances. */
export const MODEL_MARKER: unique symbol = Symbol.for('ghuri.orm.model') as any

export function isModelClass(v: unknown): v is ModelClass {
  return typeof v === 'function' && (v as any)[MODEL_MARKER] === true
}

/** Hooks installed by models/relations.ts (keeps this module dependency-light). */
export interface RegistryHooks {
  resolveField(field: RelatedField<any, any>): boolean
}

const HOOKS_KEY = Symbol.for('ghuri.orm.registryHooks')
export function setRegistryHooks(hooks: RegistryHooks): void {
  ;(globalThis as any)[HOOKS_KEY] ??= hooks
}
function getRegistryHooks(): RegistryHooks | undefined {
  return (globalThis as any)[HOOKS_KEY]
}

/**
 * Registry of model classes by app label. The global registry (`modelRegistry`) mirrors registrations
 * into core's `apps`; isolated registries (`new ModelRegistry({ isolated: true })`) are used for
 * historical models in migrations.
 */
export class ModelRegistry {
  private byLabel = new Map<string, Map<string, ModelClass>>()
  /** Every prepared concrete model (registered or not). */
  readonly all = new Set<ModelClass>()
  /** Relation fields whose target is not resolved yet. */
  readonly pending = new Set<RelatedField<any, any>>()
  readonly isolated: boolean
  private resolving = false

  constructor(opts: { isolated?: boolean } = {}) {
    this.isolated = opts.isolated ?? false
  }

  /** Register a concrete model under an app label. */
  register(appLabel: string, model: ModelClass): void {
    let bucket = this.byLabel.get(appLabel)
    if (!bucket) {
      bucket = new Map()
      this.byLabel.set(appLabel, bucket)
    }
    const key = model._meta.modelName
    const existing = bucket.get(key)
    if (existing && existing !== model) {
      throw new ImproperlyConfigured(`Conflicting '${key}' models in application '${appLabel}'.`)
    }
    bucket.set(key, model)
    this.all.add(model)
    for (const m2m of model._meta.localManyToMany) {
      const t = m2m.throughModel
      if (t?._meta.autoCreated && bucket.get(t._meta.modelName) !== t) this.register(appLabel, t)
    }
    if (!this.isolated && !model._meta.autoCreated) {
      try {
        apps.registerModel(appLabel, model)
      } catch (e) {
        if (!(e instanceof ImproperlyConfigured)) throw e
      }
    }
    this.resolvePending()
  }

  unregister(model: ModelClass): void {
    this.all.delete(model)
    for (const bucket of this.byLabel.values()) {
      for (const [k, v] of bucket) if (v === model) bucket.delete(k)
    }
  }

  getModels(appLabel?: string): ModelClass[] {
    if (appLabel) return [...(this.byLabel.get(appLabel)?.values() ?? [])]
    return [...this.byLabel.values()].flatMap((b) => [...b.values()])
  }

  /** Look up `'app.Model'` (case-insensitive model name), falling back to core `apps`. */
  getModel(dotted: string): ModelClass {
    const idx = dotted.lastIndexOf('.')
    if (idx < 0) throw new LookupError(`Model label must be 'app_label.ModelName', got '${dotted}'.`)
    const app = dotted.slice(0, idx)
    const name = dotted.slice(idx + 1).toLowerCase()
    const found = this.byLabel.get(app)?.get(name)
    if (found) return found
    if (!this.isolated) {
      const m = apps.getModel(dotted) as ModelClass
      if (isModelClass(m)) return m
    }
    throw new LookupError(`App '${app}' doesn't have a '${dotted.slice(idx + 1)}' model.`)
  }

  /** Try to resolve every pending relation; returns the fields still unresolved. */
  resolvePending(): RelatedField<any, any>[] {
    const hooks = getRegistryHooks()
    if (this.resolving || !hooks) return [...this.pending]
    this.resolving = true
    try {
      let progress = true
      while (progress && this.pending.size) {
        progress = false
        for (const field of [...this.pending]) {
          if (hooks.resolveField(field)) {
            this.pending.delete(field)
            progress = true
          }
        }
      }
    } finally {
      this.resolving = false
    }
    return [...this.pending]
  }

  /** Throw for relations that can't be resolved (after `apps.populate`). */
  checkPending(): void {
    const left = this.resolvePending()
    if (left.length) {
      const names = left.map((f) => `${f.model?._meta?.objectName ?? '?'}.${f.name} → ${String(typeof f.to === 'string' ? f.to : 'lazy target')}`)
      throw new ImproperlyConfigured(`Unresolved model relations: ${names.join(', ')}`)
    }
  }
}

export const modelRegistry: ModelRegistry = globalSingleton('ghuri.orm.registry', () => new ModelRegistry())
