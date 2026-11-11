import { ImproperlyConfigured } from '@ghuri/core'
import { ForeignKey, type ManyToManyField, type RelatedObject } from '../fields/related'
import type { Options } from './options'
import { ManyRelatedManager, RelatedManager } from './related-managers'
import type { BaseModel, ModelClass } from './types'

/**
 * Lazy awaitable for a related object that isn't cached yet. `await post.author` runs one query and
 * caches the result on the instance; later reads return the instance synchronously.
 */
export class RelatedRef<T> implements PromiseLike<T> {
  private promise?: Promise<T>
  constructor(private readonly loader: () => Promise<T>) {}
  private load(): Promise<T> {
    this.promise ??= this.loader()
    return this.promise
  }
  // biome-ignore lint/suspicious/noThenProperty: intentionally awaitable
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.load().then(onfulfilled, onrejected)
  }
  catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.load().catch(onrejected)
  }
  toString(): string {
    return '[RelatedRef: await it]'
  }
}

function isInstance(v: unknown): v is BaseModel {
  return !!v && typeof v === 'object' && '_state' in (v as object) && typeof (v as any).constructor?._meta === 'object'
}

function sameOrSubclass(cls: unknown, target: ModelClass): boolean {
  let c: any = cls
  while (c) {
    if (c === target) return true
    c = Object.getPrototypeOf(c)
  }
  try {
    return (cls as ModelClass)._meta.label === target._meta.label
  } catch {
    return false
  }
}

function defineAccessor(proto: object, name: string, desc: PropertyDescriptor, owner: string): void {
  const existing = Object.getOwnPropertyDescriptor(proto, name)
  if (existing && !(existing.get as any)?.__ghuriRelation) {
    // user-defined member wins (e.g. a method with the same name)
    return
  }
  if (desc.get) (desc.get as any).__ghuriRelation = owner
  Object.defineProperty(proto, name, { ...desc, configurable: true, enumerable: false })
}

/** FK forward accessors and M2M managers on the model prototype. */
export function installForwardDescriptors(cls: ModelClass, opts: Options): void {
  const proto = cls.prototype
  for (const f of opts.localFields) {
    if (f instanceof ForeignKey) defineAccessor(proto, f.name, forwardDescriptor(f), `${opts.objectName}.${f.name}`)
  }
  for (const m of opts.localManyToMany) {
    defineAccessor(
      proto,
      m.name,
      {
        get(this: BaseModel) {
          return new ManyRelatedManager(this, m, false)
        },
        set() {
          throw new TypeError(`Direct assignment to the forward side of a many-to-many set is prohibited. Use ${m.name}.set() instead.`)
        },
      },
      `${opts.objectName}.${m.name}`,
    )
  }
}

function forwardDescriptor(f: ForeignKey): PropertyDescriptor {
  return {
    get(this: BaseModel) {
      const state = this._state
      const id = (this as any)[f.attname]
      if (state.fieldsCache.has(f.name)) {
        const cached = state.fieldsCache.get(f.name) as BaseModel | null
        if (cached === null) {
          if (id === null || id === undefined) return null
        } else {
          const cachedId = (cached as any)[f.targetField.attname]
          if (cachedId === id || ((id === null || id === undefined) && (cachedId === null || cachedId === undefined))) return cached
        }
        state.fieldsCache.delete(f.name)
      }
      if (id === null || id === undefined) {
        if (f.null) return null
        const target = f.relatedModel
        return new RelatedRef(() =>
          Promise.reject(new target.DoesNotExist(`${(this.constructor as ModelClass)._meta.objectName} has no ${f.name}.`)),
        )
      }
      return new RelatedRef(async () => {
        if (state.fieldsCache.has(f.name)) return state.fieldsCache.get(f.name)
        const obj = await f.relatedModel._baseManager
          .getQueryset()
          .using(state.db ?? 'default')
          .get({ [f.targetField.name]: id })
        state.fieldsCache.set(f.name, obj)
        return obj
      })
    },
    set(this: BaseModel, value: unknown) {
      const state = this._state
      if (value === null || value === undefined) {
        ;(this as any)[f.attname] = null
        state.fieldsCache.set(f.name, null)
        return
      }
      if (value instanceof RelatedRef) {
        throw new TypeError(`Cannot assign an unresolved related object to '${f.name}'; await it first.`)
      }
      if (isInstance(value)) {
        const target = f.relatedModel
        if (!sameOrSubclass(value.constructor, target)) {
          throw new TypeError(
            `Cannot assign "${String(value)}": "${(this.constructor as ModelClass)._meta.objectName}.${f.name}" must be a "${target._meta.objectName}" instance.`,
          )
        }
        const v = (value as any)[f.targetField.attname]
        ;(this as any)[f.attname] = v === undefined ? null : v
        state.fieldsCache.set(f.name, value)
        if (f.oneToOne && f.remoteField) {
          const acc = f.remoteField.getAccessorName()
          if (acc) value._state.fieldsCache.set(acc, this)
        }
        return
      }
      ;(this as any)[f.attname] = value
      state.fieldsCache.delete(f.name)
    },
  }
}

/** Reverse accessor on the target model (`user.posts`, `user.profile`, `tag.posts`). */
export function installReverseDescriptor(target: ModelClass, rel: RelatedObject): void {
  const accessor = rel.getAccessorName()
  if (!accessor) return
  const targetMeta = target._meta
  if (targetMeta.getForwardField(accessor)) {
    throw new ImproperlyConfigured(
      `Reverse accessor '${targetMeta.objectName}.${accessor}' for '${rel.relatedModel._meta.objectName}.${rel.field.name}' clashes with field name '${targetMeta.objectName}.${accessor}'. Add or change relatedName.`,
    )
  }
  const owner = `${rel.relatedModel._meta.objectName}.${rel.field.name}`
  const proto = target.prototype
  if (rel.manyToMany) {
    defineAccessor(
      proto,
      accessor,
      {
        get(this: BaseModel) {
          return new ManyRelatedManager(this, rel.field as ManyToManyField, true)
        },
        set() {
          throw new TypeError(`Direct assignment to the reverse side of a many-to-many set is prohibited. Use ${accessor}.set() instead.`)
        },
      },
      owner,
    )
    return
  }
  if (rel.oneToOne) {
    const fk = rel.field as ForeignKey
    defineAccessor(
      proto,
      accessor,
      {
        get(this: BaseModel) {
          const state = this._state
          if (state.fieldsCache.has(accessor)) {
            const cached = state.fieldsCache.get(accessor) as BaseModel | null
            if (cached) return cached
            return new RelatedRef(() =>
              Promise.reject(new rel.relatedModel.DoesNotExist(`${targetMeta.objectName} has no ${accessor}.`)),
            )
          }
          const value = (this as any)[fk.targetField.attname]
          return new RelatedRef(async () => {
            if (value === null || value === undefined) {
              throw new rel.relatedModel.DoesNotExist(`${targetMeta.objectName} has no ${accessor}.`)
            }
            try {
              const obj = (await rel.relatedModel._baseManager
                .getQueryset()
                .using(state.db ?? 'default')
                .get({ [fk.name]: value })) as BaseModel
              state.fieldsCache.set(accessor, obj)
              obj._state.fieldsCache.set(fk.name, this)
              return obj
            } catch (e) {
              if (e instanceof rel.relatedModel.DoesNotExist) state.fieldsCache.set(accessor, null)
              throw e
            }
          })
        },
        set(this: BaseModel, value: BaseModel | null) {
          this._state.fieldsCache.set(accessor, value)
          if (value) {
            ;(value as any)[fk.attname] = (this as any)[fk.targetField.attname]
            value._state.fieldsCache.set(fk.name, this)
          }
        },
      },
      owner,
    )
    return
  }
  defineAccessor(
    proto,
    accessor,
    {
      get(this: BaseModel) {
        return new RelatedManager(this, rel)
      },
      set() {
        throw new TypeError(`Direct assignment to the reverse side of a related set is prohibited. Use ${accessor}.set() instead.`)
      },
    },
    owner,
  )
}
