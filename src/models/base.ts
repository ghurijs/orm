import {
  MultipleObjectsReturned as CoreMultipleObjectsReturned,
  ImproperlyConfigured,
  ObjectDoesNotExist,
  ValidationError,
} from '@ghuri/core'
import { connections, DEFAULT_DB_ALIAS } from '../db/connections'
import { DatabaseError } from '../errors'
import { type Field, isEmptyValue } from '../fields/base'
import { ForeignKey, invalidRelatedError, type ManyToManyField, RelatedField } from '../fields/related'
import { BigAutoField } from '../fields/scalar'
import { type Dialect, ident, Sql } from '../query/sql'
import { postSave, preSave } from '../signals'
import { capfirst } from '../utils'
import { Collector } from './deletion'
import { installForwardDescriptors } from './descriptors'
import { Manager } from './manager'
import { Options } from './options'
import { MODEL_MARKER, type ModelRegistry, modelRegistry } from './registry'
import type { FieldMap, ModelClass, ModelMeta, ModelState } from './types'

const OPTIONS = Symbol.for('ghuri.orm.options')
const FACTORY_BASE = Symbol.for('ghuri.orm.factoryBase')
const FACTORY_META = Symbol.for('ghuri.orm.factoryMeta')
const REGISTRY = Symbol.for('ghuri.orm.modelRegistryOverride')
const AUTO_OBJECTS = Symbol.for('ghuri.orm.autoObjects')
const BASE_MANAGER = Symbol.for('ghuri.orm.baseManager')
const DNE = Symbol.for('ghuri.orm.DoesNotExist')
const MOR = Symbol.for('ghuri.orm.MultipleObjectsReturned')
/** Pass as constructor data to build an empty instance (used when loading rows). */
export const FROM_DB: unique symbol = Symbol.for('ghuri.orm.fromDb') as any

function newState(): ModelState {
  return {
    adding: true,
    db: undefined,
    fieldsCache: new Map(),
    prefetched: new Map(),
    deferred: new Set(),
    annotations: new Set(),
  }
}

export interface SaveOptions {
  updateFields?: string[]
  forceInsert?: boolean
  forceUpdate?: boolean
  using?: string
}

export interface FullCleanOptions {
  exclude?: string[]
  validateUnique?: boolean
}

/**
 * Root class of every model (use for `instanceof`). Define models with `Model({...})`.
 */
export class BaseModel {
  static readonly [MODEL_MARKER] = true
  declare static _meta: Options
  declare static objects: Manager<any>
  declare static _defaultManager: Manager<any>
  declare static _baseManager: Manager<any>
  declare static fields: FieldMap
  declare static Meta?: ModelMeta
  declare static DoesNotExist: new (
    message?: string,
  ) => ObjectDoesNotExist
  declare static MultipleObjectsReturned: new (
    message?: string,
  ) => CoreMultipleObjectsReturned

  declare _state: ModelState
  /** Primary key value (alias of the pk attribute, e.g. `id`). */
  declare pk: any

  constructor(data?: Record<string, unknown>) {
    const cls = new.target as unknown as ModelClass
    const meta = cls._meta
    if (meta.abstract) throw new TypeError(`Abstract model '${meta.objectName}' cannot be instantiated.`)
    Object.defineProperty(this, '_state', {
      value: newState(),
      enumerable: false,
      writable: true,
      configurable: true,
    })
    if ((data as unknown) === FROM_DB) return
    initInstance(this, meta, data ?? {})
  }

  /** Generated drizzle table for this model (escape hatch). */
  static table(dialect?: Dialect): any {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic — `this` is the concrete model class
    return tableHook(this as unknown as ModelClass, dialect ?? connections.dialect())
  }

  /** Build an instance from a raw row keyed by column names (or attnames). */
  static fromRow<T extends BaseModel>(
    this: new (
      data?: any,
    ) => T,
    row: Record<string, unknown>,
    dialect?: Dialect,
  ): T {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic — `this` is the concrete model class
    const cls = this as unknown as ModelClass
    const d = dialect ?? connections.dialect()
    const values: Record<string, unknown> = {}
    const missing: string[] = []
    for (const f of cls._meta.concreteFields) {
      if (f.column in row) values[f.attname] = f.fromDb(row[f.column], d)
      else if (f.attname in row) values[f.attname] = f.fromDb(row[f.attname], d)
      else missing.push(f.attname)
    }
    return (cls as any)._fromDb(values, missing, undefined) as T
  }

  /** @internal Build an instance from converted values. */
  static _fromDb(values: Record<string, unknown>, deferred: string[], using: string | undefined): BaseModel {
    // biome-ignore lint/complexity/noThisInStatic: polymorphic — `this` is the concrete model class
    const obj = new (this as any)(FROM_DB) as BaseModel
    for (const k in values) (obj as any)[k] = values[k]
    obj._state.adding = false
    obj._state.db = using ?? DEFAULT_DB_ALIAS
    for (const d of deferred) obj._state.deferred.add(d)
    return obj
  }

  // ---- persistence ------------------------------------------------------------------------------

  async save(opts: SaveOptions = {}): Promise<void> {
    const cls = this.constructor as ModelClass
    const meta = cls._meta
    const state = this._state
    // Refuse to save with unsaved related objects; sync FK ids from cached related objects.
    for (const f of meta.concreteFields) {
      if (!(f instanceof ForeignKey) || !state.fieldsCache.has(f.name)) continue
      const rel = state.fieldsCache.get(f.name) as BaseModel | null
      if (!rel) continue
      const v = (rel as any)[f.targetField.attname]
      if (v === null || v === undefined) {
        throw new TypeError(
          `save() prohibited to prevent data loss due to unsaved related object '${f.name}'.`,
        )
      }
      if ((this as any)[f.attname] !== v) (this as any)[f.attname] = v
    }
    let updateFields: Field<any, any>[] | null = null
    if (opts.updateFields) {
      if (opts.updateFields.length === 0) return
      updateFields = opts.updateFields.map((n) => {
        const f = meta.getForwardField(n)
        if (!f?.concrete)
          throw new TypeError(`The following fields do not exist in this model or are m2m fields: ${n}`)
        return f
      })
    } else if (!state.adding && state.deferred.size) {
      updateFields = meta.concreteFields.filter((f) => !f.primaryKey && !state.deferred.has(f.attname))
    }
    const using = opts.using ?? state.db ?? DEFAULT_DB_ALIAS
    const updateNames = updateFields?.map((f) => f.name) ?? null
    await preSave.send(cls, { instance: this, raw: false, using, updateFields: updateNames })
    const conn = await connections.get(using)
    const d = conn.dialect
    const pkField = meta.pk
    const pkVal = (this as any)[pkField.attname]
    const pkSet = pkVal !== null && pkVal !== undefined
    const forceInsert = opts.forceInsert || (state.adding && pkSet && pkField.hasDefault())
    let created = false
    let updated = false
    if (pkSet && !forceInsert) {
      const fields = (updateFields ?? meta.concreteFields).filter((f) => !f.primaryKey)
      if (fields.length) {
        const sets = fields.map((f) => {
          const v = f.preSave(this, false)
          return new Sql()
            .append(ident(f.column))
            .append(' = ')
            .append(v === null || v === undefined ? Sql.raw('NULL') : f.dbParam(v, d))
        })
        const q = new Sql(['UPDATE '])
          .append(ident(meta.dbTable))
          .append(' SET ')
          .append(Sql.join(sets))
          .append(' WHERE ')
          .append(ident(pkField.column))
          .append(' = ')
          .append(pkField.dbParam(pkVal, d))
        const { sql, params } = q.render(d)
        const res = await conn.execute(sql, params)
        updated = (res.rowsAffected ?? 0) > 0
      } else {
        const q = new Sql(['SELECT 1 AS "x" FROM '])
          .append(ident(meta.dbTable))
          .append(' WHERE ')
          .append(ident(pkField.column))
          .append(' = ')
          .append(pkField.dbParam(pkVal, d))
        const { sql, params } = q.render(d)
        updated = (await conn.execute(sql, params)).rows.length > 0
      }
      if (!updated && (updateFields || opts.forceUpdate)) {
        throw new DatabaseError(
          updateFields
            ? 'Save with updateFields did not affect any rows.'
            : 'Forced update did not affect any rows.',
        )
      }
    }
    if (!updated) {
      if (opts.forceUpdate) throw new DatabaseError('Cannot force an update in save() with no primary key.')
      const fields = meta.concreteFields.filter((f) => !(f.isAutoField && !pkSet))
      const cols: Sql[] = []
      const vals: Sql[] = []
      for (const f of fields) {
        const v = f.preSave(this, true)
        cols.push(ident(f.column))
        vals.push(v === null || v === undefined ? Sql.raw('NULL') : f.dbParam(v, d))
      }
      const q = new Sql(['INSERT INTO ']).append(ident(meta.dbTable))
      if (cols.length)
        q.append(' (').append(Sql.join(cols)).append(') VALUES (').append(Sql.join(vals)).append(')')
      else q.append(' DEFAULT VALUES')
      q.append(' RETURNING ').append(ident(pkField.column))
      const { sql, params } = q.render(d)
      const res = await conn.execute(sql, params)
      const row = res.rows[0]
      if (row && row[pkField.column] !== undefined)
        (this as any)[pkField.attname] = pkField.fromDb(row[pkField.column], d)
      else if (!pkSet && res.lastInsertId !== undefined)
        (this as any)[pkField.attname] = pkField.fromDb(res.lastInsertId, d)
      created = true
    }
    state.adding = false
    state.db = using
    if (updateFields) for (const f of updateFields) state.deferred.delete(f.attname)
    await postSave.send(cls, { instance: this, created, raw: false, using, updateFields: updateNames })
  }

  /** Delete this object and emulate `onDelete` for related objects. Returns `[total, { label: n }]`. */
  async delete(
    opts: { using?: string; keepParents?: boolean } = {},
  ): Promise<[number, Record<string, number>]> {
    const meta = (this.constructor as ModelClass)._meta
    if (this.pk === null || this.pk === undefined) {
      throw new TypeError(
        `${meta.objectName} object can't be deleted because its ${meta.pk.attname} attribute is set to null.`,
      )
    }
    const collector = new Collector(opts.using ?? this._state.db ?? DEFAULT_DB_ALIAS)
    await collector.collect([this])
    return collector.delete()
  }

  /** Reload field values from the database (all, or `fields`). Clears relation caches. */
  async refreshFromDb(opts: { fields?: string[]; using?: string } = {}): Promise<void> {
    const cls = this.constructor as ModelClass
    const meta = cls._meta
    let qs = cls._baseManager.getQueryset().using(opts.using ?? this._state.db ?? DEFAULT_DB_ALIAS)
    if (opts.fields?.length) qs = qs.only(...opts.fields)
    const fresh = (await qs.filter({ pk: this.pk }).get()) as BaseModel
    const names = opts.fields?.length
      ? new Set(opts.fields.map((n) => meta.getForwardField(n)?.attname ?? n))
      : new Set(meta.concreteFields.map((f) => f.attname))
    for (const f of meta.concreteFields) {
      if (!names.has(f.attname)) continue
      ;(this as any)[f.attname] = (fresh as any)[f.attname]
      this._state.deferred.delete(f.attname)
      if (f instanceof ForeignKey) this._state.fieldsCache.delete(f.name)
    }
    if (!opts.fields?.length) {
      this._state.fieldsCache.clear()
      this._state.prefetched.clear()
    }
    this._state.adding = false
  }

  // ---- validation -------------------------------------------------------------------------------

  /** Hook for model-wide validation (override; throw ValidationError). */
  clean(): void | Promise<void> {}

  /** Clean every field (toPython + validate); collects `{ field: messages }`. */
  cleanFields(exclude: string[] = []): void {
    const meta = (this.constructor as ModelClass)._meta
    const errors: Record<string, string[]> = {}
    for (const f of meta.concreteFields) {
      if (exclude.includes(f.name) || f.isAutoField) continue
      if (this._state.deferred.has(f.attname)) continue
      const raw = (this as any)[f.attname]
      if (f.blank && isEmptyValue(raw)) continue
      try {
        ;(this as any)[f.attname] = f.clean(raw, this)
      } catch (e) {
        if (e instanceof ValidationError) errors[f.name] = [...(errors[f.name] ?? []), ...e.messages]
        else throw e
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
  }

  /** Check `unique`, `uniqueTogether` and unique constraints against the database. */
  async validateUnique(exclude: string[] = []): Promise<void> {
    const cls = this.constructor as ModelClass
    const meta = cls._meta
    const errors: Record<string, string[]> = {}
    const checks: string[][] = []
    for (const f of meta.concreteFields)
      if (f.unique && !(f.isAutoField && (this as any)[f.attname] == null)) checks.push([f.name])
    for (const ut of meta.uniqueTogether) checks.push(ut)
    for (const c of meta.constraints) if (c.type === 'unique' && !c.condition) checks.push(c.fields)
    for (const names of checks) {
      if (names.some((n) => exclude.includes(n))) continue
      const fields = names.map((n) => meta.getForwardField(n)!)
      if (fields.some((f) => !f)) continue
      const lookup: Record<string, unknown> = {}
      let skip = false
      for (const f of fields) {
        const v = (this as any)[f.attname]
        if (v === null || v === undefined || (v === '' && !f.primaryKey && f.emptyStringsAllowed && f.null)) {
          skip = true
          break
        }
        lookup[f.attname] = v
      }
      if (skip) continue
      let qs = cls._defaultManager.getQueryset().filter(lookup)
      if (!this._state.adding && this.pk !== null && this.pk !== undefined) qs = qs.exclude({ pk: this.pk })
      if (await qs.exists()) {
        const modelName = capfirst(meta.verboseName)
        if (fields.length === 1) {
          const f = fields[0]
          errors[f.name] = [
            ...(errors[f.name] ?? []),
            `${modelName} with this ${capfirst(f.verboseName)} already exists.`,
          ]
        } else {
          const labels = fields.map((f) => capfirst(f.verboseName)).join(' and ')
          errors.__all__ = [...(errors.__all__ ?? []), `${modelName} with this ${labels} already exists.`]
        }
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
  }

  /** FK values must point to existing rows. */
  async validateRelated(exclude: string[] = []): Promise<void> {
    const meta = (this.constructor as ModelClass)._meta
    const errors: Record<string, string[]> = {}
    for (const f of meta.concreteFields) {
      if (!(f instanceof ForeignKey) || exclude.includes(f.name)) continue
      const v = (this as any)[f.attname]
      if (v === null || v === undefined) continue
      const cached = this._state.fieldsCache.get(f.name) as BaseModel | undefined
      if (cached && !cached._state.adding) continue
      let qs = f.relatedModel._baseManager.getQueryset().filter({ [f.targetField.name]: v })
      const limit = f.limitChoicesTo
      if (limit) qs = qs.filter(limit)
      if (!(await qs.exists())) errors[f.name] = invalidRelatedError(f, v).messages
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
  }

  /**
   * Django's `full_clean()`: field validation (null/blank/choices/validators), `clean()`, foreign key
   * existence and uniqueness checks. Throws `ValidationError` with `messageDict`.
   */
  async fullClean(opts: FullCleanOptions = {}): Promise<void> {
    const exclude = [...(opts.exclude ?? [])]
    const errors: Record<string, string[]> = {}
    const merge = (e: unknown) => {
      if (!(e instanceof ValidationError)) throw e
      for (const [k, v] of Object.entries(e.toDict('__all__'))) {
        errors[k] = [...(errors[k] ?? []), ...v]
        if (k !== '__all__' && !exclude.includes(k)) exclude.push(k)
      }
    }
    try {
      this.cleanFields(exclude)
    } catch (e) {
      merge(e)
    }
    try {
      await this.clean()
    } catch (e) {
      merge(e)
    }
    try {
      await this.validateRelated(exclude)
    } catch (e) {
      merge(e)
    }
    if (opts.validateUnique !== false) {
      try {
        await this.validateUnique(exclude)
      } catch (e) {
        merge(e)
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors)
  }

  // ---- misc -------------------------------------------------------------------------------------

  /** Plain object of field values (FKs as `${name}Id`) plus annotations. */
  toJSON(): Record<string, unknown> {
    const meta = (this.constructor as ModelClass)._meta
    const out: Record<string, unknown> = {}
    for (const f of meta.concreteFields) {
      if (this._state.deferred.has(f.attname)) continue
      out[f.attname] = (this as any)[f.attname]
    }
    for (const a of this._state.annotations) out[a] = (this as any)[a]
    return out
  }

  /** Value of a field for serialization (FK → raw id). */
  serializableValue(fieldName: string): unknown {
    const f = (this.constructor as ModelClass)._meta.getForwardField(fieldName)
    if (!f) return (this as any)[fieldName]
    return (this as any)[f.attname]
  }

  /** Same model and same (non-null) pk. */
  isEqual(other: unknown): boolean {
    if (!(other instanceof BaseModel)) return false
    if ((other.constructor as ModelClass)._meta.label !== (this.constructor as ModelClass)._meta.label)
      return false
    return this.pk !== null && this.pk !== undefined && this.pk === other.pk
  }

  toString(): string {
    return `${(this.constructor as ModelClass)._meta.objectName} object (${String(this.pk)})`
  }
}

function initInstance(obj: BaseModel, meta: Options, data: Record<string, unknown>): void {
  const remaining = new Set(Object.keys(data))
  const o = obj as any
  for (const f of meta.concreteFields) {
    if (f instanceof ForeignKey) {
      if (f.name in data) {
        o[f.name] = data[f.name]
        remaining.delete(f.name)
        remaining.delete(f.attname)
      } else if (f.attname in data) {
        o[f.attname] = data[f.attname]
        remaining.delete(f.attname)
      } else o[f.attname] = f.getDefault()
    } else if (f.name in data) {
      o[f.attname] = data[f.name]
      remaining.delete(f.name)
    } else o[f.attname] = f.getDefault()
  }
  for (const key of remaining) {
    if (key === 'pk') {
      o.pk = data.pk
      continue
    }
    const m2m = meta.localManyToMany.find((f) => f.name === key)
    if (m2m) {
      throw new TypeError(
        `Direct assignment to the forward side of a many-to-many set is prohibited. Use ${key}.set() instead.`,
      )
    }
    if (hasSetter(obj, key)) o[key] = data[key]
    else throw new TypeError(`${meta.objectName}() got an unexpected keyword argument '${key}'`)
  }
}

function hasSetter(obj: object, key: string): boolean {
  let p = Object.getPrototypeOf(obj)
  while (p && p !== Object.prototype) {
    const d = Object.getOwnPropertyDescriptor(p, key)
    if (d) return typeof d.set === 'function'
    p = Object.getPrototypeOf(p)
  }
  return false
}

// pk accessor
Object.defineProperty(BaseModel.prototype, 'pk', {
  get(this: BaseModel) {
    return (this as any)[(this.constructor as ModelClass)._meta.pk.attname]
  },
  set(this: BaseModel, v: unknown) {
    ;(this as any)[(this.constructor as ModelClass)._meta.pk.attname] = v
  },
  configurable: true,
})

// ---- model preparation ----------------------------------------------------------------------------

function ancestry(cls: Function): Function[] {
  const chain: Function[] = []
  let c: any = cls
  while (c && c !== BaseModel && c !== Function.prototype) {
    chain.unshift(c)
    c = Object.getPrototypeOf(c)
  }
  return chain
}

const NON_INHERITED_META = new Set(['abstract', 'dbTable', 'appLabel', 'autoCreated', 'objectName', 'proxy'])

function collectMeta(cls: Function): ModelMeta {
  const merged: ModelMeta = {}
  const chain = ancestry(cls)
  for (const c of chain) {
    const own = c === cls
    const factoryMeta = Object.hasOwn(c, FACTORY_META)
      ? ((c as any)[FACTORY_META] as ModelMeta | undefined)
      : undefined
    const direct = Object.getPrototypeOf(cls) === c
    if (factoryMeta) {
      for (const [k, v] of Object.entries(factoryMeta))
        if (direct || !NON_INHERITED_META.has(k)) merged[k] = v
    }
    if (Object.hasOwn(c, 'Meta') && (c as any).Meta) {
      for (const [k, v] of Object.entries((c as any).Meta as ModelMeta))
        if (own || !NON_INHERITED_META.has(k)) merged[k] = v
    }
  }
  return merged
}

function prepareModel(cls: ModelClass): Options {
  const isFactoryBase = Object.hasOwn(cls, FACTORY_BASE)
  const meta = collectMeta(cls)
  if (isFactoryBase) meta.abstract = true
  const registry: ModelRegistry = (cls as any)[REGISTRY] ?? modelRegistry
  const opts = new Options(cls, meta, registry)
  Object.defineProperty(cls, OPTIONS, { value: opts, enumerable: false, configurable: true })
  const defs: FieldMap = (cls as any).fields ?? {}
  if (opts.abstract) {
    // Abstract models still expose unbound field info.
    for (const [name, f] of Object.entries(defs)) {
      const c = f.clone()
      c.name = name
      opts.addField(c)
    }
    return opts
  }
  const hasPk = Object.values(defs).some((f) => f.primaryKey)
  if (!hasPk) {
    if ('id' in defs) {
      throw new ImproperlyConfigured(
        `'id' can only be used as a field name if the field also sets 'primaryKey: true' (${opts.objectName}).`,
      )
    }
    const id = new BigAutoField({ primaryKey: true })
    id.autoCreated = true
    id.contributeToClass(cls, 'id')
    opts.addField(id)
  }
  const entries = Object.entries(defs)
  for (const [name, def] of entries) {
    if (name === 'pk')
      throw new ImproperlyConfigured(
        `'pk' is a reserved word that cannot be used as a field name (${opts.objectName}).`,
      )
    const f = def.clone()
    f.contributeToClass(cls, name)
    opts.addField(f)
  }
  installForwardDescriptors(cls, opts)
  bindManagers(cls, opts)
  registry.all.add(cls)
  for (const f of [...opts.localFields, ...opts.localManyToMany])
    if (f instanceof RelatedField) registry.pending.add(f)
  const label = meta.appLabel
  if (typeof label === 'string' && !meta.autoCreated) registry.register(label, cls)
  else registry.resolvePending()
  return opts
}

function bindManagers(cls: ModelClass, opts: Options): void {
  const found: Array<[string, Manager<any>]> = []
  const seen = new Set<string>()
  const chain = ancestry(cls).reverse() // most-derived first
  for (const c of chain) {
    for (const key of Object.getOwnPropertyNames(c)) {
      if (seen.has(key)) continue
      const d = Object.getOwnPropertyDescriptor(c, key)
      // A property of a more-derived class shadows the same name further up, as in JavaScript: a getter-defined
      // manager (or a non-manager value) must not be replaced by a parent's manager of that name.
      seen.add(key)
      if (!d || !('value' in d) || !(d.value instanceof Manager)) continue
      let mgr = d.value as Manager<any>
      if (c !== cls) {
        mgr = Object.assign(Object.create(Object.getPrototypeOf(mgr)), mgr) as Manager<any>
        Object.defineProperty(cls, key, { value: mgr, writable: true, configurable: true, enumerable: false })
      }
      mgr.contributeToClass(cls, key)
      found.push([key, mgr])
    }
  }
  found.sort((a, b) => a[1].creationCounter - b[1].creationCounter)
  opts.managers.push(...found)
}

/** Look up the bound `_meta` (preparing the class on first access). */
function getOptions(cls: ModelClass): Options {
  if (Object.hasOwn(cls, OPTIONS)) return (cls as any)[OPTIONS]
  return prepareModel(cls)
}

Object.defineProperty(BaseModel, '_meta', {
  get(this: ModelClass) {
    if (this === (BaseModel as unknown))
      throw new TypeError('BaseModel has no _meta; define models with Model({...}).')
    return getOptions(this)
  },
  configurable: true,
})

Object.defineProperty(BaseModel, 'objects', {
  get(this: ModelClass) {
    const meta = this._meta
    if (meta.abstract) throw new TypeError(`Manager isn't available; '${meta.objectName}' is abstract.`)
    if (!Object.hasOwn(this, AUTO_OBJECTS)) {
      const m = new Manager()
      m.contributeToClass(this, 'objects')
      m.auto = true
      Object.defineProperty(this, AUTO_OBJECTS, { value: m, configurable: true })
    }
    return (this as any)[AUTO_OBJECTS]
  },
  set(this: ModelClass, v: Manager<any>) {
    Object.defineProperty(this, 'objects', { value: v, writable: true, configurable: true })
  },
  configurable: true,
})

Object.defineProperty(BaseModel, '_defaultManager', {
  get(this: ModelClass) {
    const meta = this._meta
    const name = meta.meta.defaultManagerName as string | undefined
    if (name) {
      const m = meta.managers.find(([n]) => n === name)
      if (!m) throw new ImproperlyConfigured(`${meta.objectName} has no manager named '${name}'.`)
      return m[1]
    }
    return this.objects
  },
  configurable: true,
})

Object.defineProperty(BaseModel, '_baseManager', {
  get(this: ModelClass) {
    void this._meta
    if (!Object.hasOwn(this, BASE_MANAGER)) {
      const m = new Manager()
      m.contributeToClass(this, '_baseManager')
      Object.defineProperty(this, BASE_MANAGER, { value: m, configurable: true })
    }
    return (this as any)[BASE_MANAGER]
  },
  configurable: true,
})

function errorClassGetter(key: symbol, base: new (msg?: string) => Error, name: string) {
  return {
    get(this: ModelClass) {
      if (!Object.hasOwn(this, key)) {
        const parent = Object.getPrototypeOf(this)
        const parentErr =
          parent &&
          parent !== BaseModel &&
          typeof parent === 'function' &&
          (parent as any)[MODEL_MARKER] &&
          !Object.hasOwn(parent, FACTORY_BASE)
            ? (parent as any)[name]
            : base
        const cls = class extends (parentErr as new (msg?: string) => Error) {}
        Object.defineProperty(cls, 'name', { value: name })
        Object.defineProperty(this, key, { value: cls, configurable: true })
      }
      return (this as any)[key]
    },
    configurable: true,
  }
}
Object.defineProperty(BaseModel, 'DoesNotExist', errorClassGetter(DNE, ObjectDoesNotExist, 'DoesNotExist'))
Object.defineProperty(
  BaseModel,
  'MultipleObjectsReturned',
  errorClassGetter(MOR, CoreMultipleObjectsReturned, 'MultipleObjectsReturned'),
)
;(BaseModel as any).fields = {}

// drizzle.ts installs the table builder.
let tableHook: (model: ModelClass, dialect: Dialect) => any = () => {
  throw new Error('drizzle table builder not installed')
}
export function setTableBuilder(fn: (model: ModelClass, dialect: Dialect) => any): void {
  tableHook = fn
}

// ---- Model() factory & typing ---------------------------------------------------------------------

type AnyCtor = abstract new (...args: any) => any
type FieldValue<F> = F extends { __value: infer T; __options: infer O }
  ? O extends { null: true }
    ? T | null
    : T
  : never
type IsNull<F> = F extends { __options: infer O } ? (O extends { null: true } ? true : false) : false
type TargetOf<F> = F extends { __target: infer M }
  ? M extends abstract new (
      ...a: any
    ) => infer I
    ? I
    : BaseModel
  : BaseModel
type PkFromFields<FF> = {
  [K in keyof FF]: FF[K] extends { __value: infer T; __options: infer O }
    ? O extends { primaryKey: true }
      ? T
      : never
    : never
}[keyof FF]
/** Primary key type of a FK target, read from the target's static field map (number for implicit ids). */
type TargetPk<F> = F extends { __target: infer M }
  ? M extends { fields: infer FF }
    ? [PkFromFields<FF>] extends [never]
      ? number
      : PkFromFields<FF>
    : number
  : number
type FKKeys<F> = { [K in keyof F]: F[K] extends ForeignKey<any, any> ? K : never }[keyof F]
type M2MKeys<F> = { [K in keyof F]: F[K] extends ManyToManyField<any, any> ? K : never }[keyof F]
type PlainKeys<F> = Exclude<keyof F, FKKeys<F> | M2MKeys<F>>
type HasPk<F> = true extends {
  [K in keyof F]: F[K] extends { __options: infer O }
    ? O extends { primaryKey: true }
      ? true
      : false
    : false
}[keyof F]
  ? true
  : false

/** Awaitable related object: `await post.author` (also assignable: `post.author = user`). */
export type Related<I, N extends boolean = false> = N extends true
  ? I | null | PromiseLike<I | null>
  : I | PromiseLike<I>

/** Instance properties inferred from a field map. */
export type ModelFields<F> = { -readonly [K in PlainKeys<F>]: FieldValue<F[K]> } & {
  -readonly [K in FKKeys<F>]: Related<TargetOf<F[K]>, IsNull<F[K]>>
} & {
  -readonly [K in FKKeys<F> as `${K & string}Id`]: IsNull<F[K]> extends true
    ? TargetPk<F[K]> | null
    : TargetPk<F[K]>
} & {
  readonly [K in M2MKeys<F>]: import('./related-managers').ManyRelatedManager<TargetOf<F[K]>>
} & (HasPk<F> extends true ? {} : { id: number })

/** Constructor / `create()` data inferred from a field map. */
export type ModelInit<F> = {
  [K in PlainKeys<F>]?:
    | FieldValue<F[K]>
    | (F[K] extends { __value: infer T } ? T | string | number | null : never)
} & {
  [K in FKKeys<F>]?: BaseModel | TargetPk<F[K]> | null
} & {
  [K in FKKeys<F> as `${K & string}Id`]?: TargetPk<F[K]> | null
} & { pk?: unknown; id?: unknown }

type FieldsOf<B> = B extends { fields: infer X } ? (string extends keyof X ? {} : X) : {}

export type ModelBaseClass<F extends FieldMap, B extends AnyCtor> = {
  new (data?: ModelInit<F & FieldsOf<B>> & Record<string, unknown>): InstanceType<B> & ModelFields<F>
  fields: FieldsOf<B> & F
  objects: Manager<InstanceType<B> & ModelFields<F>>
  Meta?: ModelMeta
} & Omit<B, 'prototype' | 'fields' | 'objects' | 'Meta'>

export interface ModelFactoryOptions<B> {
  /** Abstract model to inherit fields, Meta and methods from. */
  extends?: B
  /** Meta for the subclass (alternative to `static Meta`). */
  meta?: ModelMeta
}

/**
 * Create a model base class from a field map:
 *
 * ```ts
 * export class Post extends Model({ title: new CharField({ maxLength: 200 }) }) {
 *   static Meta = { ordering: ['-id'] }
 * }
 * ```
 */
export function Model<F extends FieldMap, B extends AnyCtor = typeof BaseModel>(
  fields: F,
  options: ModelFactoryOptions<B> = {},
): ModelBaseClass<F, B> {
  const Base = (options.extends ?? BaseModel) as unknown as typeof BaseModel
  if (options.extends && !(Base as any)[MODEL_MARKER])
    throw new TypeError('Model({...}, { extends }) needs a model class.')
  const merged: FieldMap = { ...(((Base as any).fields as FieldMap | undefined) ?? {}), ...fields }
  const ModelBase = class extends Base {}
  Object.defineProperty(ModelBase, 'name', { value: 'ModelBase' })
  Object.defineProperty(ModelBase, 'fields', {
    value: merged,
    writable: true,
    configurable: true,
    enumerable: true,
  })
  Object.defineProperty(ModelBase, FACTORY_BASE, { value: true })
  Object.defineProperty(ModelBase, FACTORY_META, { value: options.meta })
  return ModelBase as any
}

/**
 * Build a named model class dynamically (migrations' historical models, M2M through models).
 * `registry` defaults to the global one; pass an isolated `ModelRegistry` for historical states.
 */
export function createModelClass(
  name: string,
  fields: FieldMap,
  opts: { meta?: ModelMeta; registry?: ModelRegistry; base?: typeof BaseModel; appLabel?: string } = {},
): ModelClass {
  const Base = opts.base ?? BaseModel
  const cls = class extends Base {}
  Object.defineProperty(cls, 'name', { value: name })
  Object.defineProperty(cls, 'fields', {
    value: { ...fields },
    writable: true,
    configurable: true,
    enumerable: true,
  })
  const meta: ModelMeta = { ...(opts.meta ?? {}) }
  if (opts.appLabel && meta.appLabel === undefined) meta.appLabel = opts.appLabel
  Object.defineProperty(cls, 'Meta', { value: meta, writable: true, configurable: true, enumerable: true })
  if (opts.registry) Object.defineProperty(cls, REGISTRY, { value: opts.registry })
  return cls as unknown as ModelClass
}

/** Is this class abstract (or a `Model()` factory base)? */
export function isAbstractModel(cls: unknown): boolean {
  if (typeof cls !== 'function' || !(cls as any)[MODEL_MARKER]) return false
  if (cls === BaseModel || Object.hasOwn(cls, FACTORY_BASE)) return true
  return (cls as ModelClass)._meta.abstract
}

/**
 * Assign an app label and register models (what `apps.populate` does for `AppConfig.models`).
 * Useful in tests and scripts: `registerModels('blog', { Post, Tag })`.
 */
export function registerModels(appLabel: string, models: Record<string, unknown> | unknown[]): ModelClass[] {
  const list = Array.isArray(models) ? models : Object.values(models)
  const out: ModelClass[] = []
  for (const m of list) {
    if (typeof m !== 'function' || !(m as any)[MODEL_MARKER] || isAbstractModel(m)) continue
    const cls = m as ModelClass
    const meta = cls._meta
    meta.setAppLabel(appLabel)
    meta.registry.register(meta.appLabel, cls)
    out.push(cls)
  }
  return out
}
