import { ImproperlyConfigured } from '@ghuri/core'
import type { Field } from '../fields/base'
import { ManyToManyField, RelatedObject } from '../fields/related'
import { FieldDoesNotExist } from '../errors'
import { capfirst, humanize } from '../utils'
import type { Manager } from './manager'
import { type ModelRegistry, modelRegistry } from './registry'
import type { ConstraintSpec, IndexSpec, ModelClass, ModelMeta } from './types'

const DEFAULT_PERMISSIONS = ['add', 'change', 'delete', 'view']

type Lazy<T> = T | (() => T)
function lazy<T>(v: Lazy<T>): T {
  return typeof v === 'function' ? (v as () => T)() : v
}

/**
 * `Model._meta` — the public, stable model introspection API used by admin, rest, agents, cli and
 * migrations (Django's `Options`).
 */
export class Options {
  readonly model: ModelClass
  readonly meta: ModelMeta
  readonly registry: ModelRegistry
  readonly abstract: boolean
  readonly objectName: string
  readonly modelName: string
  readonly autoCreated: boolean
  readonly managed: boolean
  /** Concrete forward fields (in order: pk first, then definition order). */
  readonly localFields: Field<any, any>[] = []
  readonly localManyToMany: ManyToManyField[] = []
  pk!: Field<any, any>
  /** Reverse relations pointing at this model (including hidden ones). */
  readonly _relatedObjects: RelatedObject[] = []
  /** Managers in definition order (`[name, manager]`). */
  readonly managers: Array<[string, Manager<any>]> = []
  private _appLabel?: string
  private _forwardCache?: Map<string, Field<any, any>>

  constructor(model: ModelClass, meta: ModelMeta, registry: ModelRegistry = modelRegistry) {
    this.model = model
    this.meta = meta
    this.registry = registry
    this.abstract = meta.abstract === true
    this.autoCreated = meta.autoCreated === true
    this.managed = meta.managed !== false
    this.objectName = (meta.objectName as string | undefined) ?? model.name
    this.modelName = this.objectName.toLowerCase()
    if (!this.objectName) {
      throw new ImproperlyConfigured('Model classes must be named (class Post extends Model({...}) {}).')
    }
  }

  // ---- identity ---------------------------------------------------------------------------------

  get appLabel(): string {
    const label = this._appLabel ?? (this.meta.appLabel !== undefined ? lazy(this.meta.appLabel as Lazy<string>) : undefined)
    if (!label) {
      throw new ImproperlyConfigured(
        `Model ${this.objectName} doesn't declare an explicit appLabel and isn't in an application in INSTALLED_APPS ` +
          `(add it to an AppConfig's models, set Meta.appLabel, or call registerModels()).`,
      )
    }
    return label
  }

  /** Set by app registration; `Meta.appLabel` takes precedence. */
  setAppLabel(label: string): void {
    if (this.meta.appLabel === undefined) this._appLabel = label
  }

  get hasAppLabel(): boolean {
    return this._appLabel !== undefined || this.meta.appLabel !== undefined
  }

  get label(): string {
    return `${this.appLabel}.${this.objectName}`
  }

  get labelLower(): string {
    return `${this.appLabel}.${this.modelName}`
  }

  get dbTable(): string {
    if (this.meta.dbTable !== undefined) return lazy(this.meta.dbTable as Lazy<string>)
    return `${this.appLabel}_${this.modelName}`
  }

  get verboseName(): string {
    return (this.meta.verboseName as string | undefined) ?? humanize(this.objectName)
  }

  get verboseNamePlural(): string {
    return (this.meta.verboseNamePlural as string | undefined) ?? `${this.verboseName}s`
  }

  get verboseNameRaw(): string {
    return capfirst(this.verboseName)
  }

  get ordering(): string[] {
    return (this.meta.ordering as string[] | undefined) ?? []
  }

  get uniqueTogether(): string[][] {
    const ut = this.meta.uniqueTogether
    if (!ut || ut.length === 0) return []
    return (Array.isArray(ut[0]) ? ut : [ut]) as string[][]
  }

  get indexes(): IndexSpec[] {
    return (this.meta.indexes as IndexSpec[] | undefined) ?? []
  }

  get constraints(): ConstraintSpec[] {
    return (this.meta.constraints as ConstraintSpec[] | undefined) ?? []
  }

  get permissions(): Array<[string, string]> {
    return (this.meta.permissions as Array<[string, string]> | undefined) ?? []
  }

  get defaultPermissions(): string[] {
    return (this.meta.defaultPermissions as string[] | undefined) ?? DEFAULT_PERMISSIONS
  }

  get getLatestBy(): string[] | undefined {
    const g = this.meta.getLatestBy
    return g === undefined ? undefined : Array.isArray(g) ? g : [g as string]
  }

  // ---- fields -----------------------------------------------------------------------------------

  /** Forward non-M2M fields (Django's `_meta.fields`). */
  get fields(): Field<any, any>[] {
    return this.localFields
  }

  /** Fields with a database column. */
  get concreteFields(): Field<any, any>[] {
    return this.localFields.filter((f) => f.concrete)
  }

  get manyToMany(): ManyToManyField[] {
    return this.localManyToMany
  }

  /** Reverse relations (FK, O2O, M2M) pointing to this model; hidden ones excluded. */
  get relatedObjects(): RelatedObject[] {
    this.registry.resolvePending()
    return this._relatedObjects.filter((r) => !r.hidden || r.manyToMany)
  }

  /** All reverse relations including hidden ones (auto-created through models). Used by deletion. */
  get allRelatedObjects(): RelatedObject[] {
    this.registry.resolvePending()
    return this._relatedObjects
  }

  /** All forward fields including M2M. */
  get forwardFields(): Field<any, any>[] {
    return [...this.localFields, ...this.localManyToMany]
  }

  /** Forward fields, M2M and (non-hidden) reverse relations. */
  getFields(opts: { includeHidden?: boolean } = {}): Array<Field<any, any> | RelatedObject> {
    const reverse = opts.includeHidden ? this.allRelatedObjects : this.relatedObjects
    return [...this.forwardFields, ...reverse]
  }

  /** @internal */
  addField(field: Field<any, any>): void {
    this._forwardCache = undefined
    if (field instanceof ManyToManyField) this.localManyToMany.push(field)
    else {
      if (field.primaryKey) {
        if (this.pk) throw new ImproperlyConfigured(`Model ${this.objectName} can't have more than one primary key.`)
        this.pk = field
        this.localFields.unshift(field)
      } else this.localFields.push(field)
    }
  }

  private forwardMap(): Map<string, Field<any, any>> {
    if (!this._forwardCache) {
      const m = new Map<string, Field<any, any>>()
      for (const f of this.forwardFields) {
        m.set(f.name, f)
        if (f.attname && !m.has(f.attname)) m.set(f.attname, f)
      }
      this._forwardCache = m
    }
    return this._forwardCache
  }

  /** Forward field by name or attname, without reverse relations. */
  getForwardField(name: string): Field<any, any> | undefined {
    if (name === 'pk') return this.pk
    return this.forwardMap().get(name)
  }

  /** Field (by name, attname or `'pk'`) or reverse relation (by query name); `undefined` if missing. */
  findField(name: string): Field<any, any> | RelatedObject | undefined {
    const f = this.getForwardField(name)
    if (f) return f
    this.registry.resolvePending()
    return this._relatedObjects.find((r) => !r.field.reverseHidden && r.name === name)
  }

  /** Reverse relation by accessor name (`user.posts` → 'posts'). */
  getRelatedObjectByAccessor(accessor: string): RelatedObject | undefined {
    this.registry.resolvePending()
    return this._relatedObjects.find((r) => r.getAccessorName() === accessor)
  }

  /** Django's `_meta.get_field(name)`: forward field or reverse relation. Throws FieldDoesNotExist. */
  getField(name: string): Field<any, any> | RelatedObject {
    const f = this.findField(name)
    if (!f) throw new FieldDoesNotExist(`${this.objectName} has no field named '${name}'`)
    return f
  }

  /** Names usable in lookups (for error messages). */
  lookupNames(): string[] {
    this.registry.resolvePending()
    return [
      ...this.forwardFields.map((f) => f.name),
      ...this._relatedObjects.filter((r) => !r.field.reverseHidden && !r.relatedModel._meta.autoCreated).map((r) => r.name),
      'pk',
    ].sort()
  }

  /** The default manager (Meta.defaultManagerName, else the first one, normally `objects`). */
  get defaultManager(): Manager<any> {
    return this.model._defaultManager
  }

  toString(): string {
    try {
      return `<Options for ${this.label}>`
    } catch {
      return `<Options for ${this.objectName}>`
    }
  }
}
