import { FieldError } from '../errors'
import { ForeignKey, ManyToManyField, type RelatedObject } from '../fields/related'
import type { BaseModel, ModelClass } from '../models/types'
import { LOOKUP_SEP } from '../utils'
import type { QuerySet } from './queryset'

/** `prefetchRelated(new Prefetch('comments', { queryset: Comment.objects.filter(...), toAttr: 'approved' }))` */
export class Prefetch {
  readonly lookup: string
  readonly queryset?: QuerySet<any>
  readonly toAttr?: string
  constructor(lookup: string, opts: { queryset?: QuerySet<any>; toAttr?: string } = {}) {
    this.lookup = lookup
    this.queryset = opts.queryset
    this.toAttr = opts.toAttr
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function dedupeObjects(objs: BaseModel[]): BaseModel[] {
  const seen = new Set<BaseModel>()
  return objs.filter((o) => (seen.has(o) ? false : (seen.add(o), true)))
}

/** Prefetch `lookups` for already-fetched `instances` (Django's `prefetch_related_objects`). */
export async function prefetchRelatedObjects(instances: BaseModel[], lookups: Array<string | Prefetch>): Promise<void> {
  for (const l of lookups) {
    const pf = typeof l === 'string' ? new Prefetch(l) : l
    await prefetchOne(instances, pf)
  }
}

async function prefetchOne(instances: BaseModel[], pf: Prefetch): Promise<void> {
  const parts = pf.lookup.split(LOOKUP_SEP)
  let current = instances
  for (let i = 0; i < parts.length; i++) {
    if (!current.length) return
    const part = parts[i]
    const last = i === parts.length - 1
    const qs = last ? pf.queryset : undefined
    const toAttr = last ? pf.toAttr : undefined
    const model = current[0].constructor as ModelClass
    const meta = model._meta
    const field = meta.getForwardField(part)
    const rel = field ? undefined : meta.getRelatedObjectByAccessor(part)
    if (field instanceof ForeignKey && part === field.name) {
      current = await prefetchForward(current, field, qs, toAttr)
    } else if (field instanceof ManyToManyField) {
      current = await prefetchM2M(current, field, false, part, qs, toAttr)
    } else if (rel?.manyToMany) {
      current = await prefetchM2M(current, rel.field as ManyToManyField, true, part, qs, toAttr)
    } else if (rel?.oneToOne) {
      current = await prefetchReverseOne(current, rel, qs)
    } else if (rel) {
      current = await prefetchReverseMany(current, rel, part, qs, toAttr)
    } else {
      throw new FieldError(
        `Cannot find '${part}' on ${meta.objectName} object, '${pf.lookup}' is an invalid parameter to prefetchRelated()`,
      )
    }
  }
}

async function prefetchForward(objs: BaseModel[], f: ForeignKey, qs: QuerySet<any> | undefined, toAttr?: string): Promise<BaseModel[]> {
  if (!toAttr && objs.every((o) => o._state.fieldsCache.has(f.name))) {
    return dedupeObjects(objs.map((o) => o._state.fieldsCache.get(f.name) as BaseModel | null).filter(Boolean) as BaseModel[])
  }
  const ids = unique(objs.map((o) => (o as any)[f.attname]).filter((v) => v !== null && v !== undefined))
  const target = f.relatedModel
  const tf = f.targetField
  const related = ids.length
    ? ((await (qs ?? target._baseManager.getQueryset()).filter({ [`${tf.name}__in`]: ids }).fetch()) as BaseModel[])
    : []
  const byKey = new Map(related.map((r) => [(r as any)[tf.attname], r]))
  for (const o of objs) {
    const v = byKey.get((o as any)[f.attname]) ?? null
    if (toAttr) (o as any)[toAttr] = v
    else o._state.fieldsCache.set(f.name, v)
  }
  return related
}

async function prefetchReverseOne(objs: BaseModel[], rel: RelatedObject, qs: QuerySet<any> | undefined): Promise<BaseModel[]> {
  const fk = rel.field as ForeignKey
  const accessor = rel.getAccessorName()!
  const vals = unique(objs.map((o) => (o as any)[fk.targetField.attname]).filter((v) => v !== null && v !== undefined))
  const related = vals.length
    ? ((await (qs ?? rel.relatedModel._baseManager.getQueryset()).filter({ [`${fk.name}__in`]: vals }).fetch()) as BaseModel[])
    : []
  const byKey = new Map(related.map((r) => [(r as any)[fk.attname], r]))
  for (const o of objs) {
    const r = byKey.get((o as any)[fk.targetField.attname]) ?? null
    o._state.fieldsCache.set(accessor, r)
    if (r) r._state.fieldsCache.set(fk.name, o)
  }
  return related
}

async function prefetchReverseMany(
  objs: BaseModel[],
  rel: RelatedObject,
  accessor: string,
  qs: QuerySet<any> | undefined,
  toAttr?: string,
): Promise<BaseModel[]> {
  if (!toAttr && !qs && objs.every((o) => o._state.prefetched.has(accessor))) {
    return dedupeObjects(objs.flatMap((o) => o._state.prefetched.get(accessor) ?? []))
  }
  const fk = rel.field as ForeignKey
  const vals = unique(objs.map((o) => (o as any)[fk.targetField.attname]).filter((v) => v !== null && v !== undefined))
  const related = vals.length
    ? ((await (qs ?? rel.relatedModel._defaultManager.getQueryset()).filter({ [`${fk.name}__in`]: vals }).fetch()) as BaseModel[])
    : []
  const groups = new Map<unknown, BaseModel[]>()
  for (const r of related) {
    const k = (r as any)[fk.attname]
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  for (const o of objs) {
    const list = groups.get((o as any)[fk.targetField.attname]) ?? []
    for (const r of list) r._state.fieldsCache.set(fk.name, o)
    if (toAttr) (o as any)[toAttr] = list
    else o._state.prefetched.set(accessor, list)
  }
  return related
}

async function prefetchM2M(
  objs: BaseModel[],
  field: ManyToManyField,
  reverse: boolean,
  accessor: string,
  qs: QuerySet<any> | undefined,
  toAttr?: string,
): Promise<BaseModel[]> {
  if (!toAttr && !qs && objs.every((o) => o._state.prefetched.has(accessor))) {
    return dedupeObjects(objs.flatMap((o) => o._state.prefetched.get(accessor) ?? []))
  }
  const [a, b] = field.throughFieldNames()
  const through = field.through
  const srcFk = through._meta.getForwardField(reverse ? b : a) as ForeignKey
  const tgtFk = through._meta.getForwardField(reverse ? a : b) as ForeignKey
  const targetModel = reverse ? field.model : field.relatedModel
  const srcVals = unique(objs.map((o) => (o as any)[srcFk.targetField.attname]).filter((v) => v !== null && v !== undefined))
  const pairs = srcVals.length
    ? ((await through._baseManager.getQueryset().filter({ [`${srcFk.attname}__in`]: srcVals }).valuesList(srcFk.attname, tgtFk.attname).fetch()) as Array<
        [unknown, unknown]
      >)
    : []
  const tgtIds = unique(pairs.map((p) => p[1]))
  const targets = tgtIds.length
    ? ((await (qs ?? targetModel._defaultManager.getQueryset()).filter({ [`${tgtFk.targetField.name}__in`]: tgtIds }).fetch()) as BaseModel[])
    : []
  const bySrc = new Map<unknown, Set<unknown>>()
  for (const [s, t] of pairs) {
    const set = bySrc.get(s)
    if (set) set.add(t)
    else bySrc.set(s, new Set([t]))
  }
  for (const o of objs) {
    const ids = bySrc.get((o as any)[srcFk.targetField.attname])
    const list = ids ? targets.filter((t) => ids.has((t as any)[tgtFk.targetField.attname])) : []
    if (toAttr) (o as any)[toAttr] = list
    else o._state.prefetched.set(accessor, list)
  }
  return targets
}
