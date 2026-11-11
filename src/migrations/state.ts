import { apps as coreApps, ImproperlyConfigured } from '@ghuri/core'
import type { FieldDeconstruction } from '../fields/base'
import { fieldFromSpec } from '../fields/index'
import { createModelClass, isAbstractModel } from '../models/base'
import { isModelClass, ModelRegistry } from '../models/registry'
import type { ConstraintSpec, IndexSpec, ModelClass, ModelMeta } from '../models/types'
import { shortHash } from '../utils'

/** A field in a migration: `{ type: 'CharField', maxLength: 200 }` (flat) or `{ type, options }`. */
export type FieldSpec = { type: string; options?: Record<string, unknown> } & Record<string, unknown>

/** Meta options tracked by migrations. */
export const MODEL_OPTION_KEYS = [
  'dbTable',
  'ordering',
  'verboseName',
  'verboseNamePlural',
  'uniqueTogether',
  'indexes',
  'constraints',
  'permissions',
  'defaultPermissions',
  'getLatestBy',
  'managed',
  'defaultManagerName',
] as const

/** Options changed by `AlterModelOptions` (no database effect). */
export const ALTER_OPTION_KEYS = [
  'ordering',
  'verboseName',
  'verboseNamePlural',
  'permissions',
  'defaultPermissions',
  'getLatestBy',
  'managed',
  'defaultManagerName',
] as const

/** `{ type, ...options }` / `{ type, options }` → `{ type, options }` (undefined values dropped). */
export function normalizeFieldSpec(spec: FieldSpec | FieldDeconstruction): FieldDeconstruction {
  const { type, options: nested, ...flat } = spec as FieldSpec
  const options: Record<string, unknown> = {}
  for (const [k, v] of Object.entries({ ...(nested ?? {}), ...flat })) if (v !== undefined) options[k] = v
  return { type, options }
}

/** Option order in migration files (others follow alphabetically). */
const OPTION_ORDER = [
  'to',
  'onDelete',
  'onDeleteValue',
  'toField',
  'through',
  'throughFields',
  'primaryKey',
  'maxLength',
  'maxDigits',
  'decimalPlaces',
  'null',
  'blank',
  'unique',
  'default',
  'dbDefault',
  'autoNow',
  'autoNowAdd',
  'choices',
  'dbColumn',
  'dbTable',
  'dbIndex',
  'relatedName',
  'relatedQueryName',
]

/** `{ type, options }` → `{ type, ...options }` (the form written to migration files, in a readable order). */
export function flattenFieldSpec(spec: FieldDeconstruction): Record<string, unknown> {
  const keys = Object.keys(spec.options).sort((a, b) => {
    const ia = OPTION_ORDER.indexOf(a)
    const ib = OPTION_ORDER.indexOf(b)
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
    return a.localeCompare(b)
  })
  const out: Record<string, unknown> = { type: spec.type }
  for (const k of keys) out[k] = spec.options[k]
  return out
}

/** Stable JSON used to compare specs (sorted keys; relation labels case-insensitive). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown, key?: string): unknown => {
    if (v instanceof Date) return v.toISOString()
    if (v instanceof Uint8Array) return { __bytes: [...v] }
    if (Array.isArray(v)) return v.map((x) => norm(x))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k]
        if (x !== undefined) out[k] = norm(x, k)
      }
      return out
    }
    if (typeof v === 'string' && (key === 'to' || key === 'through')) return v.toLowerCase()
    return v
  }
  return JSON.stringify(norm(value))
}

export function fieldSpecsEqual(a: FieldDeconstruction, b: FieldDeconstruction): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** Deterministic default index name (same scheme as the schema editors). */
export function defaultIndexName(table: string, columns: string[], suffix = '_idx'): string {
  const hash = shortHash(table, ...columns, suffix)
  let base = `${table}_${columns.join('_')}`
  const max = 63 - hash.length - suffix.length - 1
  if (base.length > max) base = base.slice(0, max)
  return `${base}_${hash}${suffix}`
}

/**
 * The migration-state description of one model (Django's `ModelState`): field specs and Meta options,
 * renderable into a historical model class.
 */
export class ModelState {
  readonly fields: Map<string, FieldDeconstruction>
  options: Record<string, unknown>

  constructor(
    readonly appLabel: string,
    public name: string,
    fields: Map<string, FieldDeconstruction> | Record<string, FieldSpec | FieldDeconstruction>,
    options: Record<string, unknown> = {},
  ) {
    this.fields =
      fields instanceof Map
        ? fields
        : new Map(Object.entries(fields).map(([k, v]) => [k, normalizeFieldSpec(v as FieldSpec)]))
    this.options = { ...options }
  }

  get nameLower(): string {
    return this.name.toLowerCase()
  }

  get key(): string {
    return `${this.appLabel}.${this.nameLower}`
  }

  get label(): string {
    return `${this.appLabel}.${this.name}`
  }

  clone(): ModelState {
    return new ModelState(
      this.appLabel,
      this.name,
      new Map([...this.fields].map(([k, v]) => [k, { type: v.type, options: { ...v.options } }])),
      structuredCloneOptions(this.options),
    )
  }

  getField(name: string): FieldDeconstruction {
    const f = this.fields.get(name)
    if (!f)
      throw new ImproperlyConfigured(`${this.label} has no field named '${name}' in the migration state.`)
    return f
  }

  get uniqueTogether(): string[][] {
    return normalizeUniqueTogether(this.options.uniqueTogether)
  }

  get indexes(): IndexSpec[] {
    return (this.options.indexes as IndexSpec[] | undefined) ?? []
  }

  get constraints(): ConstraintSpec[] {
    return (this.options.constraints as ConstraintSpec[] | undefined) ?? []
  }

  /** The table this model uses (explicit `dbTable` or `${app}_${model}`). */
  get dbTable(): string {
    return (this.options.dbTable as string | undefined) ?? `${this.appLabel}_${this.nameLower}`
  }

  /** Build a historical model class in `registry`. */
  render(registry: ModelRegistry): ModelClass {
    const fields: Record<string, any> = {}
    for (const [name, spec] of this.fields) fields[name] = fieldFromSpec(spec as any)
    const meta: ModelMeta = { ...structuredCloneOptions(this.options), appLabel: this.appLabel }
    return createModelClass(this.name, fields, { meta, registry })
  }

  /** Snapshot of a live model class. */
  static fromModel(model: ModelClass): ModelState {
    const meta = model._meta
    const fields = new Map<string, FieldDeconstruction>()
    for (const f of [...meta.localFields, ...meta.localManyToMany]) {
      const d = f.deconstruct()
      fields.set(f.name, normalizeFieldSpec(d))
    }
    const raw = meta.meta
    const options: Record<string, unknown> = {}
    for (const k of MODEL_OPTION_KEYS) {
      if (raw[k] === undefined) continue
      switch (k) {
        case 'dbTable':
          options.dbTable = meta.dbTable
          break
        case 'uniqueTogether': {
          const ut = meta.uniqueTogether
          if (ut.length) options.uniqueTogether = ut.map((s) => [...s])
          break
        }
        case 'indexes': {
          const idx = meta.indexes.map((i) => {
            const named: IndexSpec = { ...i, fields: [...i.fields] }
            if (!named.name) {
              const cols = i.fields.map((n) => {
                const desc = n.startsWith('-')
                const col = meta.getForwardField(n.replace(/^-/, ''))?.column ?? n
                return desc ? col : col
              })
              named.name = defaultIndexName(meta.dbTable, cols, i.unique ? '_uniq' : '_idx')
            }
            return stripUndefined(named)
          })
          if (idx.length) options.indexes = idx
          break
        }
        case 'constraints':
          if (meta.constraints.length)
            options.constraints = meta.constraints.map((c) => stripUndefined({ ...c }))
          break
        case 'managed':
          if (raw.managed === false) options.managed = false
          break
        default:
          options[k] = structuredCloneOptions({ v: raw[k] }).v
      }
    }
    return new ModelState(meta.appLabel, meta.objectName, fields, options)
  }
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o)) if ((o as any)[k] === undefined) delete (o as any)[k]
  return o
}

function structuredCloneOptions(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function') out[k] = v
    else if (Array.isArray(v)) out[k] = JSON.parse(JSON.stringify(v))
    else if (v && typeof v === 'object') out[k] = JSON.parse(JSON.stringify(v))
    else out[k] = v
  }
  return out
}

export function normalizeUniqueTogether(ut: unknown): string[][] {
  if (!Array.isArray(ut) || ut.length === 0) return []
  return (Array.isArray(ut[0]) ? ut : [ut]) as string[][]
}

/**
 * Historical models rendered from a `ProjectState` in an isolated registry (Django's `StateApps`). Passed to
 * `RunCode` callbacks: `apps.getModel('blog.Post')` returns the model as it was at that migration.
 */
export class StateApps {
  readonly registry = new ModelRegistry({ isolated: true })

  constructor(models: Iterable<ModelState>) {
    const states = [...models]
    for (const ms of states) {
      const cls = ms.render(this.registry)
      void cls._meta
    }
    const left = this.registry.resolvePending()
    if (left.length) {
      const names = left.map(
        (f) => `${f.model?._meta?.label ?? '?'}.${f.name} → ${typeof f.to === 'string' ? f.to : '?'}`,
      )
      throw new ImproperlyConfigured(
        `Related model(s) can't be resolved in the migration state: ${names.join(', ')}. ` +
          'Make sure the migration depends on the migration that creates the related model.',
      )
    }
  }

  /** `getModel('blog.Post')` or `getModel('blog', 'Post')` (case-insensitive model name). */
  getModel(labelOrApp: string, modelName?: string): ModelClass {
    return this.registry.getModel(modelName === undefined ? labelOrApp : `${labelOrApp}.${modelName}`)
  }

  getModels(appLabel?: string): ModelClass[] {
    return this.registry.getModels(appLabel).filter((m) => !m._meta.autoCreated)
  }
}

/**
 * The whole project's model state at some point of the migration history (Django's `ProjectState`).
 * Built by replaying operations; `apps` renders historical model classes on demand.
 */
export class ProjectState {
  readonly models = new Map<string, ModelState>()
  /** Apps whose models are taken from the live app registry (apps without migrations). */
  readonly realApps = new Set<string>()
  private _apps?: StateApps

  constructor(models: Iterable<ModelState> = [], realApps: Iterable<string> = []) {
    for (const m of models) this.models.set(m.key, m)
    for (const a of realApps) this.realApps.add(a)
  }

  static key(appLabel: string, name: string): string {
    return `${appLabel}.${name.toLowerCase()}`
  }

  addModel(ms: ModelState): void {
    this.models.set(ms.key, ms)
    this.invalidate()
  }

  removeModel(appLabel: string, name: string): void {
    this.models.delete(ProjectState.key(appLabel, name))
    this.invalidate()
  }

  hasModel(appLabel: string, name: string): boolean {
    return this.models.has(ProjectState.key(appLabel, name))
  }

  getModel(appLabel: string, name: string): ModelState {
    const ms = this.models.get(ProjectState.key(appLabel, name))
    if (!ms) throw new ImproperlyConfigured(`Model '${appLabel}.${name}' is not in the migration state.`)
    return ms
  }

  /** Models of an app. */
  appModels(appLabel: string): ModelState[] {
    return [...this.models.values()].filter((m) => m.appLabel === appLabel)
  }

  /** Forget rendered models after a mutation. */
  invalidate(): void {
    this._apps = undefined
  }

  clone(): ProjectState {
    return new ProjectState(
      [...this.models.values()].map((m) => m.clone()),
      this.realApps,
    )
  }

  /** Rendered historical models (cached until the next mutation). */
  get apps(): StateApps {
    if (!this._apps) this._apps = new StateApps(this.models.values())
    return this._apps
  }

  /** State of live model classes. */
  static fromModels(models: Iterable<ModelClass>): ProjectState {
    const state = new ProjectState()
    for (const m of models) {
      if (isAbstractModel(m) || m._meta.autoCreated) continue
      state.models.set(ProjectState.key(m._meta.appLabel, m._meta.objectName), ModelState.fromModel(m))
    }
    return state
  }

  /** State of every installed model (`apps.getModels()`), optionally limited to some apps. */
  static fromApps(appLabels?: Iterable<string>): ProjectState {
    const only = appLabels ? new Set(appLabels) : null
    const models = (coreApps.getModels() as unknown[]).filter(
      (m): m is ModelClass => isModelClass(m) && (!only || only.has(m._meta.appLabel)),
    )
    return ProjectState.fromModels(models)
  }

  /** Rewrite relation targets `from` → `to` ('app.Model' labels) in every model (RenameModel). */
  renameRelationTargets(from: string, to: string): void {
    const lower = from.toLowerCase()
    for (const ms of this.models.values()) {
      for (const spec of ms.fields.values()) {
        for (const key of ['to', 'through'] as const) {
          const v = spec.options[key]
          if (typeof v === 'string' && v.toLowerCase() === lower) spec.options[key] = to
        }
      }
    }
    this.invalidate()
  }
}
