import { ImproperlyConfigured } from '@ghuri/core'
import type { Expression, OrderBy } from '../query/expressions'
import {
  type AggregateSpec,
  type BulkCreateOptions,
  type CreateData,
  type FilterArg,
  QuerySet,
  type ValuesListOptions,
} from '../query/queryset'
import type { BaseModel, ModelClass } from './types'

let managerCounter = 0

/**
 * Django's Manager: the entry point for queries (`Post.objects.filter(...)`). Subclass and override
 * `getQueryset()` for custom managers:
 *
 * ```ts
 * class PublishedManager extends Manager<Post> {
 *   getQueryset() { return super.getQueryset().filter({ published: true }) }
 * }
 * class Post extends Model({...}) { static published = new PublishedManager() }
 * ```
 */
export class Manager<T = any> {
  model!: ModelClass
  name = ''
  /** True for the implicit `objects` manager. */
  auto = false
  readonly creationCounter = managerCounter++

  /** Called when the model class is prepared. */
  contributeToClass(model: ModelClass, name: string): void {
    this.model = model
    this.name = name
  }

  protected assertBound(): void {
    if (!this.model) {
      throw new ImproperlyConfigured(
        `Manager '${this.constructor.name}' isn't bound to a model yet: register the model (INSTALLED_APPS / registerModels) or access Model._meta first.`,
      )
    }
  }

  /** Base QuerySet of this manager; override for custom managers. */
  getQueryset(): QuerySet<T> {
    this.assertBound()
    return new QuerySet<T>(this.model)
  }

  /** The manager's base QuerySet (prefetched results are kept, like Django). */
  all(): QuerySet<T> {
    return this.getQueryset()
  }
  filter(...args: FilterArg<T>[]): QuerySet<T> {
    return this.getQueryset().filter(...args)
  }
  exclude(...args: FilterArg<T>[]): QuerySet<T> {
    return this.getQueryset().exclude(...args)
  }
  get(...args: FilterArg<T>[]): Promise<T> {
    return this.getQueryset().get(...args)
  }
  first(): Promise<T | null> {
    return this.getQueryset().first()
  }
  last(): Promise<T | null> {
    return this.getQueryset().last()
  }
  latest(...fields: string[]): Promise<T> {
    return this.getQueryset().latest(...fields)
  }
  earliest(...fields: string[]): Promise<T> {
    return this.getQueryset().earliest(...fields)
  }
  count(): Promise<number> {
    return this.getQueryset().count()
  }
  exists(): Promise<boolean> {
    return this.getQueryset().exists()
  }
  create(data?: CreateData<T>): Promise<T> {
    return this.getQueryset().create(data)
  }
  getOrCreate(
    lookup: FilterArg<T> & Record<string, unknown>,
    opts?: { defaults?: CreateData<T> },
  ): Promise<[T, boolean]> {
    return this.getQueryset().getOrCreate(lookup, opts)
  }
  updateOrCreate(
    lookup: FilterArg<T> & Record<string, unknown>,
    opts?: { defaults?: CreateData<T>; createDefaults?: CreateData<T> },
  ): Promise<[T, boolean]> {
    return this.getQueryset().updateOrCreate(lookup, opts)
  }
  bulkCreate(objs: T[], opts?: BulkCreateOptions): Promise<T[]> {
    return this.getQueryset().bulkCreate(objs, opts)
  }
  bulkUpdate(objs: T[], fields: string[], opts?: { batchSize?: number }): Promise<number> {
    return this.getQueryset().bulkUpdate(objs, fields, opts)
  }
  inBulk(ids?: unknown[], opts?: { fieldName?: string }): Promise<Map<unknown, T>> {
    return this.getQueryset().inBulk(ids, opts)
  }
  aggregate<S extends AggregateSpec>(spec: S): Promise<{ [K in keyof S]: any }> {
    return this.getQueryset().aggregate(spec)
  }
  annotate(spec: Record<string, Expression>): QuerySet<T> {
    return this.getQueryset().annotate(spec)
  }
  orderBy(...fields: Array<string | OrderBy | Expression>): QuerySet<T> {
    return this.getQueryset().orderBy(...fields)
  }
  values(...fields: string[]): QuerySet<Record<string, any>> {
    return this.getQueryset().values(...fields)
  }
  valuesList(...args: Array<string | ValuesListOptions>): QuerySet<any> {
    return this.getQueryset().valuesList(...args)
  }
  distinct(): QuerySet<T> {
    return this.getQueryset().distinct()
  }
  only(...fields: string[]): QuerySet<T> {
    return this.getQueryset().only(...fields)
  }
  defer(...fields: string[]): QuerySet<T> {
    return this.getQueryset().defer(...fields)
  }
  none(): QuerySet<T> {
    return this.getQueryset().none()
  }
  using(alias: string): QuerySet<T> {
    return this.getQueryset().using(alias)
  }
  slice(start: number, end?: number): QuerySet<T> {
    return this.getQueryset().slice(start, end)
  }
  selectRelated(...paths: Array<string | null>): QuerySet<T> {
    return this.getQueryset().selectRelated(...paths)
  }
  prefetchRelated(...lookups: Array<string | import('../query/prefetch').Prefetch | null>): QuerySet<T> {
    return this.getQueryset().prefetchRelated(...lookups)
  }
  update(values: Record<string, unknown>): Promise<number> {
    return this.getQueryset().update(values)
  }
  iterator(): AsyncGenerator<T> {
    return this.getQueryset().iterator()
  }

  toString(): string {
    return `<${this.constructor.name}: ${this.model?.name ?? 'unbound'}.${this.name}>`
  }
}

/** Instance type of a model class. */
export type InstanceOf<M> = M extends new (...a: any) => infer I ? I : BaseModel
