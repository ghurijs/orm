import { atomic } from '../db/connections'
import type { ForeignKey, ManyToManyField, RelatedObject } from '../fields/related'
import type { QuerySet } from '../query/queryset'
import { m2mChanged } from '../signals'
import { isPlainObject } from '../utils'
import { Manager } from './manager'
import type { BaseModel, ModelClass } from './types'

function isInstance(v: unknown): v is BaseModel {
  return !!v && typeof v === 'object' && '_state' in (v as object) && typeof (v as any).constructor?._meta === 'object'
}

function splitOptions<O extends object>(args: unknown[]): [unknown[], O] {
  const last = args[args.length - 1]
  if (isPlainObject(last) && !isInstance(last)) return [args.slice(0, -1), last as O]
  return [args, {} as O]
}

/** Reverse side of a ForeignKey: `user.posts` (filter/create/add/remove/set/clear). */
export class RelatedManager<T = any> extends Manager<T> {
  readonly field: ForeignKey
  readonly accessor: string

  constructor(
    readonly instance: BaseModel,
    readonly rel: RelatedObject,
  ) {
    super()
    this.field = rel.field as ForeignKey
    this.model = rel.relatedModel
    this.accessor = rel.getAccessorName() ?? rel.name
    this.name = this.accessor
  }

  private get value(): unknown {
    const v = (this.instance as any)[this.field.targetField.attname]
    if (v === null || v === undefined) {
      throw new TypeError(
        `"${String(this.instance)}" needs to have a value for field "${this.field.targetField.name}" before this relationship can be used.`,
      )
    }
    return v
  }

  private get db(): string {
    return this.instance._state.db ?? 'default'
  }

  override getQueryset(): QuerySet<T> {
    const value = this.value
    const qs = (this.model._defaultManager.getQueryset() as QuerySet<T>).using(this.db).filter({ [this.field.name]: value } as any)
    const cached = this.instance._state.prefetched.get(this.accessor)
    if (cached) return qs._withResults(cached as unknown as T[])
    return qs
  }

  override async create(data: Record<string, unknown> = {}): Promise<T> {
    const obj = await super.create({ ...data, [this.field.name]: this.instance } as any)
    this.instance._state.prefetched.delete(this.accessor)
    return obj
  }

  override getOrCreate(lookup: Record<string, unknown>, opts: { defaults?: Record<string, unknown> } = {}): Promise<[T, boolean]> {
    return this.getQueryset().getOrCreate({ ...lookup, [this.field.name]: this.instance }, opts)
  }

  override updateOrCreate(
    lookup: Record<string, unknown>,
    opts: { defaults?: Record<string, unknown>; createDefaults?: Record<string, unknown> } = {},
  ): Promise<[T, boolean]> {
    return this.getQueryset().updateOrCreate({ ...lookup, [this.field.name]: this.instance }, opts)
  }

  /** Point `objs` at this instance (`bulk`: one UPDATE for saved objects, default true). */
  async add(...args: Array<T | { bulk?: boolean }>): Promise<void> {
    const [objs, opts] = splitOptions<{ bulk?: boolean }>(args)
    const value = this.value
    const bulk = opts.bulk ?? true
    const list = objs as BaseModel[]
    for (const o of list) {
      if (!(o instanceof (this.model as any))) throw new TypeError(`'${this.model._meta.objectName}' instance expected, got ${String(o)}`)
    }
    if (bulk) {
      for (const o of list) {
        if (o._state.adding) {
          throw new TypeError(`instance isn't saved. Use bulk: false or save the object first: ${String(o)}`)
        }
      }
      if (list.length) {
        await this.model._baseManager
          .getQueryset()
          .using(this.db)
          .filter({ pk__in: list.map((o) => o.pk) })
          .update({ [this.field.name]: value })
      }
      for (const o of list) {
        ;(o as any)[this.field.attname] = value
        o._state.fieldsCache.set(this.field.name, this.instance)
      }
    } else {
      await atomic(async () => {
        for (const o of list) {
          ;(o as any)[this.field.name] = this.instance
          await o.save()
        }
      }, { using: this.db })
    }
    this.instance._state.prefetched.delete(this.accessor)
  }

  private assertNullable(op: string): void {
    if (!this.field.null) {
      throw new TypeError(`'${op}' is not available on the '${this.accessor}' related manager because '${this.model._meta.objectName}.${this.field.name}' is not nullable.`)
    }
  }

  async remove(...args: Array<T | { bulk?: boolean }>): Promise<void> {
    this.assertNullable('remove')
    const [objs] = splitOptions(args)
    const value = this.value
    const list = objs as BaseModel[]
    if (!list.length) return
    await this.model._baseManager
      .getQueryset()
      .using(this.db)
      .filter({ pk__in: list.map((o) => o.pk), [this.field.name]: value })
      .update({ [this.field.name]: null })
    for (const o of list) {
      ;(o as any)[this.field.attname] = null
      o._state.fieldsCache.set(this.field.name, null)
    }
    this.instance._state.prefetched.delete(this.accessor)
  }

  async clear(): Promise<void> {
    this.assertNullable('clear')
    await this.model._baseManager.getQueryset().using(this.db).filter({ [this.field.name]: this.value }).update({ [this.field.name]: null })
    this.instance._state.prefetched.delete(this.accessor)
  }

  /** Make the related set exactly `objs`. */
  async set(objs: T[], opts: { clear?: boolean; bulk?: boolean } = {}): Promise<void> {
    const list = objs as unknown as BaseModel[]
    await atomic(async () => {
      if (opts.clear) {
        await this.clear()
        await this.add(...(list as any), { bulk: opts.bulk })
        return
      }
      const current = (await this.model._baseManager
        .getQueryset()
        .using(this.db)
        .filter({ [this.field.name]: this.value })
        .valuesList('pk', { flat: true })
        .fetch()) as unknown[]
      const wanted = new Set(list.map((o) => o.pk))
      const toRemove = current.filter((pk) => !wanted.has(pk))
      if (toRemove.length) {
        this.assertNullable('set')
        await this.model._baseManager.getQueryset().using(this.db).filter({ pk__in: toRemove }).update({ [this.field.name]: null })
      }
      const have = new Set(current)
      const toAdd = list.filter((o) => o._state.adding || !have.has(o.pk))
      if (toAdd.length) await this.add(...(toAdd as any), { bulk: opts.bulk })
    }, { using: this.db })
    this.instance._state.prefetched.delete(this.accessor)
  }
}

/** Both sides of a ManyToManyField: `post.tags` and `tag.posts`. */
export class ManyRelatedManager<T = any> extends Manager<T> {
  readonly through: ModelClass
  readonly srcFk: ForeignKey
  readonly tgtFk: ForeignKey
  readonly accessor: string

  constructor(
    readonly instance: BaseModel,
    readonly field: ManyToManyField,
    readonly reverse: boolean,
  ) {
    super()
    this.model = reverse ? field.model : field.relatedModel
    this.through = field.through
    const [a, b] = field.throughFieldNames()
    const tmeta = this.through._meta
    this.srcFk = tmeta.getForwardField(reverse ? b : a) as ForeignKey
    this.tgtFk = tmeta.getForwardField(reverse ? a : b) as ForeignKey
    this.accessor = reverse ? (field.remoteField?.getAccessorName() ?? '') : field.name
    this.name = this.accessor
  }

  private get sourceValue(): unknown {
    const v = (this.instance as any)[this.srcFk.targetField.attname]
    if (v === null || v === undefined) {
      throw new TypeError(
        `"${String(this.instance)}" needs to have a value for field "${this.srcFk.targetField.name}" before this many-to-many relationship can be used.`,
      )
    }
    return v
  }

  private get db(): string {
    return this.instance._state.db ?? 'default'
  }

  private throughQs(): QuerySet<any> {
    return this.through._baseManager.getQueryset().using(this.db).filter({ [this.srcFk.attname]: this.sourceValue })
  }

  override getQueryset(): QuerySet<T> {
    const ids = this.throughQs().valuesList(this.tgtFk.attname, { flat: true })
    const qs = (this.model._defaultManager.getQueryset() as QuerySet<T>)
      .using(this.db)
      .filter({ [`${this.tgtFk.targetField.name}__in`]: ids } as any)
    const cached = this.instance._state.prefetched.get(this.accessor)
    if (cached) return qs._withResults(cached as unknown as T[])
    return qs
  }

  private targetValue(obj: unknown): unknown {
    if (isInstance(obj)) {
      if (!(obj instanceof (this.model as any))) {
        throw new TypeError(`'${this.model._meta.objectName}' instance expected, got ${String(obj)}`)
      }
      const v = (obj as any)[this.tgtFk.targetField.attname]
      if (v === null || v === undefined) {
        throw new TypeError(`Cannot add "${String(obj)}": the value for field "${this.tgtFk.targetField.name}" is None`)
      }
      return v
    }
    return obj
  }

  private async send(action: 'pre_add' | 'post_add' | 'pre_remove' | 'post_remove' | 'pre_clear' | 'post_clear', pkSet: Set<unknown> | null) {
    await m2mChanged.send(this.through, {
      instance: this.instance,
      action,
      reverse: this.reverse,
      model: this.model,
      pkSet,
      using: this.db,
    })
  }

  /** Add objects (instances or primary keys). Existing links are skipped. */
  async add(...args: Array<T | unknown | { throughDefaults?: Record<string, unknown> }>): Promise<void> {
    const [objs, opts] = splitOptions<{ throughDefaults?: Record<string, unknown> }>(args)
    const src = this.sourceValue
    const ids = [...new Set(objs.map((o) => this.targetValue(o)))]
    if (!ids.length) return
    await atomic(async () => {
      const existing = new Set(
        (await this.throughQs()
          .filter({ [`${this.tgtFk.attname}__in`]: ids })
          .valuesList(this.tgtFk.attname, { flat: true })
          .fetch()) as unknown[],
      )
      const missing = ids.filter((id) => !existing.has(id))
      await this.send('pre_add', new Set(missing))
      if (missing.length) {
        const Through = this.through as unknown as new (d: Record<string, unknown>) => BaseModel
        const rows = missing.map((id) => new Through({ ...(opts.throughDefaults ?? {}), [this.srcFk.attname]: src, [this.tgtFk.attname]: id }))
        await this.through._baseManager.getQueryset().using(this.db).bulkCreate(rows)
      }
      await this.send('post_add', new Set(missing))
    }, { using: this.db })
    this.instance._state.prefetched.delete(this.accessor)
  }

  async remove(...objs: unknown[]): Promise<void> {
    const ids = [...new Set(objs.map((o) => this.targetValue(o)))]
    if (!ids.length) return
    await atomic(async () => {
      await this.send('pre_remove', new Set(ids))
      await this.throughQs().filter({ [`${this.tgtFk.attname}__in`]: ids }).delete()
      await this.send('post_remove', new Set(ids))
    }, { using: this.db })
    this.instance._state.prefetched.delete(this.accessor)
  }

  async clear(): Promise<void> {
    void this.sourceValue
    await atomic(async () => {
      await this.send('pre_clear', null)
      await this.throughQs().delete()
      await this.send('post_clear', null)
    }, { using: this.db })
    this.instance._state.prefetched.delete(this.accessor)
  }

  /** Make the set exactly `objs` (minimal add/remove unless `clear: true`). */
  async set(objs: unknown[], opts: { clear?: boolean; throughDefaults?: Record<string, unknown> } = {}): Promise<void> {
    await atomic(async () => {
      if (opts.clear) {
        await this.clear()
        if (objs.length) await this.add(...objs, { throughDefaults: opts.throughDefaults })
        return
      }
      const current = (await this.throughQs().valuesList(this.tgtFk.attname, { flat: true }).fetch()) as unknown[]
      const wanted = objs.map((o) => this.targetValue(o))
      const wantedSet = new Set(wanted)
      const currentSet = new Set(current)
      const toRemove = current.filter((id) => !wantedSet.has(id))
      const toAdd = wanted.filter((id) => !currentSet.has(id))
      if (toRemove.length) await this.remove(...toRemove)
      if (toAdd.length) await this.add(...toAdd, { throughDefaults: opts.throughDefaults })
    }, { using: this.db })
    this.instance._state.prefetched.delete(this.accessor)
  }

  /** Create a target object and link it. */
  override async create(data: Record<string, unknown> = {}, opts: { throughDefaults?: Record<string, unknown> } = {}): Promise<T> {
    return atomic(async () => {
      const obj = await this.model._defaultManager.getQueryset().using(this.db).create(data as any)
      await this.add(obj, { throughDefaults: opts.throughDefaults })
      return obj as T
    }, { using: this.db })
  }
}
