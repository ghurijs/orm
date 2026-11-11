import { Http404 } from '@ghuri/core'
import { Manager } from './models/manager'
import type { BaseModel, ModelClass } from './models/types'
import { type FilterArg, QuerySet } from './query/queryset'

type Source<T> = QuerySet<T> | Manager<T> | (ModelClass & { objects: Manager<T> })

function toQueryset<T>(source: Source<T>): QuerySet<T> {
  if (source instanceof QuerySet) return source
  if (source instanceof Manager) return source.all()
  return (source as ModelClass)._defaultManager.all() as unknown as QuerySet<T>
}

/** `get()` or throw core `Http404` (Django's `get_object_or_404`). */
export async function getObjectOr404<T = BaseModel>(source: Source<T>, ...lookup: FilterArg<T>[]): Promise<T> {
  const qs = toQueryset(source)
  try {
    return await qs.get(...lookup)
  } catch (e) {
    if (e instanceof qs.model.DoesNotExist) {
      throw new Http404(`No ${qs.model._meta.objectName} matches the given query.`)
    }
    throw e
  }
}

/** `filter()` results or throw `Http404` when empty (Django's `get_list_or_404`). */
export async function getListOr404<T = BaseModel>(source: Source<T>, ...lookup: FilterArg<T>[]): Promise<T[]> {
  const qs = toQueryset(source)
  const list = await qs.filter(...lookup).fetch()
  if (!list.length) throw new Http404(`No ${qs.model._meta.objectName} matches the given query.`)
  return list
}
