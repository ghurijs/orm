import { atomic, connections } from '../db/connections'
import { ProtectedError, RestrictedError } from '../errors'
import type { Field } from '../fields/base'
import {
  CASCADE,
  DO_NOTHING,
  type ForeignKey,
  PROTECT,
  RESTRICT,
  SET_DEFAULT,
  SET_NULL,
} from '../fields/related'
import { Compiler, compilePkSubquery } from '../query/compiler'
import type { QuerySet } from '../query/queryset'
import { ident, Sql } from '../query/sql'
import { postDelete, preDelete } from '../signals'
import { chunk } from '../utils'
import type { BaseModel, ModelClass } from './types'

interface FieldUpdate {
  model: ModelClass
  field: Field<any, any>
  value: unknown
  objs: BaseModel[]
  /** The model whose deletion triggered the update (the FK's target). */
  target: ModelClass
}

/**
 * Django-style deletion collector: walks reverse relations and emulates `onDelete` in the ORM so
 * behavior is identical on D1, SQLite and PostgreSQL.
 */
function addEdge(map: Map<ModelClass, Set<ModelClass>>, parent: ModelClass, child: ModelClass): void {
  if (parent === child) return
  let set = map.get(parent)
  if (!set) {
    set = new Set()
    map.set(parent, set)
  }
  set.add(child)
}

export class Collector {
  /** model → (pk → instance), in collection order. */
  readonly data = new Map<ModelClass, Map<unknown, BaseModel>>()
  readonly fastDeletes: QuerySet<any>[] = []
  readonly fieldUpdates: FieldUpdate[] = []
  readonly restricted: Array<{ objs: BaseModel[]; label: string }> = []
  /** parent → children that must be deleted first (CASCADE). */
  private readonly children = new Map<ModelClass, Set<ModelClass>>()
  /**
   * parent → models that point at it through SET_NULL / SET_DEFAULT / SET(). When rows of both are
   * deleted, the referencing rows should go first too; this edge only orders, it is dropped if it
   * would contradict a CASCADE edge.
   */
  private readonly softChildren = new Map<ModelClass, Set<ModelClass>>()

  constructor(
    readonly using: string,
    readonly origin?: unknown,
  ) {}

  private isCollected(obj: BaseModel): boolean {
    return this.data.get(obj.constructor as ModelClass)?.has(obj.pk) ?? false
  }

  private add(objs: BaseModel[]): BaseModel[] {
    const added: BaseModel[] = []
    for (const o of objs) {
      const model = o.constructor as ModelClass
      let bucket = this.data.get(model)
      if (!bucket) {
        bucket = new Map()
        this.data.set(model, bucket)
      }
      if (!bucket.has(o.pk)) {
        bucket.set(o.pk, o)
        added.push(o)
      }
    }
    return added
  }

  /** No signal receivers and no relations that need emulation → plain DELETE. */
  canFastDelete(model: ModelClass): boolean {
    if (preDelete.hasListeners(model) || postDelete.hasListeners(model)) return false
    return model._meta.allRelatedObjects.every(
      (r) => r.manyToMany || (r.field as ForeignKey).onDelete === DO_NOTHING,
    )
  }

  async collectQuerySet(qs: QuerySet<BaseModel>): Promise<void> {
    if (this.canFastDelete(qs.model)) {
      this.fastDeletes.push(qs)
      return
    }
    const objs = await qs.orderBy().selectRelated(null).prefetchRelated(null).using(this.using).fetch()
    await this.collect(objs)
  }

  async collect(objs: BaseModel[]): Promise<void> {
    if (!objs.length) return
    const newObjs = this.add(objs)
    if (!newObjs.length) return
    const model = newObjs[0].constructor as ModelClass
    for (const rel of model._meta.allRelatedObjects) {
      if (rel.manyToMany) continue // through rows are handled by the through model's FKs
      const fk = rel.field as ForeignKey
      const onDelete = fk.onDelete
      if (onDelete === DO_NOTHING) continue
      const relatedModel = rel.relatedModel
      const values = [
        ...new Set(
          newObjs.map((o) => (o as any)[fk.targetField.attname]).filter((v) => v !== null && v !== undefined),
        ),
      ]
      if (!values.length) continue
      const qs = relatedModel._baseManager
        .getQueryset()
        .using(this.using)
        .filter({ [`${fk.name}__in`]: values })
      if (onDelete === CASCADE) {
        this.addChild(model, relatedModel)
        if (this.canFastDelete(relatedModel)) {
          this.fastDeletes.push(qs)
        } else {
          await this.collect(await qs.fetch())
        }
        continue
      }
      const related = (await qs.fetch()) as BaseModel[]
      if (!related.length) continue
      if (onDelete === PROTECT) {
        throw new ProtectedError(
          `Cannot delete some instances of model '${model._meta.objectName}' because they are referenced through protected foreign keys: '${relatedModel._meta.objectName}.${fk.name}'.`,
          related,
        )
      }
      if (onDelete === RESTRICT) {
        this.restricted.push({ objs: related, label: `${relatedModel._meta.objectName}.${fk.name}` })
        continue
      }
      let value: unknown = null
      if (onDelete === SET_NULL) value = null
      else if (onDelete === SET_DEFAULT) value = fk.getDefault()
      else if (typeof onDelete === 'object' && onDelete.kind === 'SET') {
        value = typeof onDelete.value === 'function' ? (onDelete.value as () => unknown)() : onDelete.value
        if (value && typeof value === 'object' && 'pk' in (value as object)) value = (value as BaseModel).pk
      }
      addEdge(this.softChildren, model, relatedModel)
      this.fieldUpdates.push({ model: relatedModel, field: fk, value, objs: related, target: model })
    }
  }

  private addChild(parent: ModelClass, child: ModelClass): void {
    addEdge(this.children, parent, child)
  }

  /**
   * Models ordered so that referencing (child) models are deleted before their parents: CASCADE
   * edges first, then every SET_NULL / SET_DEFAULT / SET() edge that doesn't close a cycle. D1 runs
   * each statement in its own transaction, so a deferred FK is checked right after the DELETE; the
   * order (or, where no order exists, the field update) is what keeps it satisfied.
   */
  private deletionOrder(): ModelClass[] {
    const edges = new Map<ModelClass, Set<ModelClass>>()
    for (const [parent, set] of this.children) for (const c of set) addEdge(edges, parent, c)
    const reaches = (from: ModelClass, to: ModelClass): boolean => {
      const seen = new Set<ModelClass>()
      const stack = [from]
      while (stack.length) {
        const m = stack.pop()!
        if (m === to) return true
        if (seen.has(m)) continue
        seen.add(m)
        for (const c of edges.get(m) ?? []) stack.push(c)
      }
      return false
    }
    for (const [parent, set] of this.softChildren) {
      if (!this.data.has(parent)) continue
      for (const c of set) {
        if (!this.data.has(c) || edges.get(parent)?.has(c)) continue
        if (!reaches(c, parent)) addEdge(edges, parent, c)
      }
    }
    const out: ModelClass[] = []
    const visiting = new Set<ModelClass>()
    const done = new Set<ModelClass>()
    const visit = (m: ModelClass) => {
      if (done.has(m) || visiting.has(m)) return
      visiting.add(m)
      for (const c of edges.get(m) ?? []) visit(c)
      visiting.delete(m)
      done.add(m)
      out.push(m)
    }
    for (const m of this.data.keys()) visit(m)
    return out.filter((m) => this.data.has(m))
  }

  async delete(): Promise<[number, Record<string, number>]> {
    for (const r of this.restricted) {
      const remaining = r.objs.filter((o) => !this.isCollected(o))
      if (remaining.length) {
        throw new RestrictedError(
          `Cannot delete some instances because they are referenced through restricted foreign keys: '${r.label}'.`,
          remaining,
        )
      }
    }
    const counts: Record<string, number> = {}
    const bump = (m: ModelClass, n: number) => {
      if (n) counts[m._meta.label] = (counts[m._meta.label] ?? 0) + n
    }
    await atomic(
      async () => {
        const conn = await connections.get(this.using)
        const d = conn.dialect
        const maxParams = Math.max(1, conn.features.maxQueryParams - 5)
        const order = this.deletionOrder()
        const position = new Map(order.map((m, i) => [m, i]))
        // A row that is itself being deleted needs no field update when its model is deleted before
        // the target's. Otherwise (same model, or a cycle) it is updated first, as Django does, so
        // the target's DELETE never leaves a dangling reference.
        const deletedFirst = (upd: FieldUpdate, o: BaseModel) =>
          upd.model !== upd.target &&
          this.isCollected(o) &&
          position.get(upd.model)! < (position.get(upd.target) ?? Number.POSITIVE_INFINITY)
        for (const [model, bucket] of this.data) {
          for (const obj of bucket.values())
            await preDelete.send(model, { instance: obj, using: this.using, origin: this.origin })
        }
        for (const qs of this.fastDeletes) {
          const compiler = new Compiler(d, conn.features)
          const meta = qs.model._meta
          const sub = compilePkSubquery({ ...qs.state, ordering: [] }, compiler)
          const q = new Sql(['DELETE FROM ']).append(ident(meta.dbTable))
          if (sub) q.append(' WHERE ').append(ident(meta.pk.column)).append(' IN (').append(sub).append(')')
          const { sql, params } = q.render(d)
          bump(qs.model, (await conn.execute(sql, params)).rowsAffected ?? 0)
        }
        for (const upd of this.fieldUpdates) {
          const objs = upd.objs.filter((o) => !deletedFirst(upd, o))
          if (!objs.length) continue
          const meta = upd.model._meta
          for (const batch of chunk(objs, maxParams - 1)) {
            const value =
              upd.value === null || upd.value === undefined
                ? Sql.raw('NULL')
                : upd.field.dbParam(upd.value, d)
            const q = new Sql(['UPDATE '])
              .append(ident(meta.dbTable))
              .append(' SET ')
              .append(ident(upd.field.column))
              .append(' = ')
              .append(value)
              .append(' WHERE ')
              .append(ident(meta.pk.column))
              .append(' IN (')
              .append(Sql.join(batch.map((o) => meta.pk.dbParam(o.pk, d))))
              .append(')')
            const { sql, params } = q.render(d)
            await conn.execute(sql, params)
            for (const o of batch) {
              ;(o as any)[upd.field.attname] = upd.value
              o._state.fieldsCache.delete(upd.field.name)
            }
          }
        }
        for (const model of order) {
          const meta = model._meta
          // Later-collected rows (self-referencing children) go first.
          const instances = [...this.data.get(model)!.values()].reverse()
          for (const batch of chunk(instances, maxParams)) {
            const q = new Sql(['DELETE FROM '])
              .append(ident(meta.dbTable))
              .append(' WHERE ')
              .append(ident(meta.pk.column))
              .append(' IN (')
              .append(Sql.join(batch.map((o) => meta.pk.dbParam(o.pk, d))))
              .append(')')
            const { sql, params } = q.render(d)
            bump(model, (await conn.execute(sql, params)).rowsAffected ?? 0)
          }
        }
        for (const [model, bucket] of this.data) {
          for (const obj of bucket.values())
            await postDelete.send(model, { instance: obj, using: this.using, origin: this.origin })
        }
      },
      { using: this.using },
    )
    for (const bucket of this.data.values()) {
      for (const obj of bucket.values()) {
        obj.pk = null
        obj._state.adding = true
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    return [total, counts]
  }
}
