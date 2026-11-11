import { apps, ImproperlyConfigured } from '@ghuri/core'
import { CASCADE, ForeignKey, ManyToManyField, type RelatedField, RelatedObject, setRelationResolver } from '../fields/related'
import { globalSingleton, lowerFirst } from '../utils'
import { createModelClass, registerModels } from './base'
import { installReverseDescriptor } from './descriptors'
import { isModelClass, modelRegistry, setRegistryHooks } from './registry'
import type { ModelClass, ModelMeta } from './types'

function resolveTarget(field: RelatedField<any, any>, to: unknown): ModelClass {
  if (typeof to === 'string') {
    if (to === 'self') return field.model
    const label = to.includes('.') ? to : `${field.model._meta.appLabel}.${to}`
    return field.model._meta.registry.getModel(label)
  }
  if (isModelClass(to)) return to
  if (typeof to === 'function') {
    const r = (to as () => unknown)()
    if (!isModelClass(r)) throw new TypeError(`Relation target of ${String(field)} did not return a model class.`)
    return r
  }
  throw new TypeError(`Invalid relation target for ${String(field)}.`)
}

function createAutoThrough(field: ManyToManyField, target: ModelClass): ModelClass {
  const src = field.model
  const srcMeta = src._meta
  const tgtMeta = target._meta
  const self = src === target
  const fromName = self ? `from${srcMeta.objectName}` : lowerFirst(srcMeta.objectName)
  const toName = self ? `to${tgtMeta.objectName}` : lowerFirst(tgtMeta.objectName)
  const name = `${srcMeta.objectName}_${field.name}`
  const meta: ModelMeta = {
    appLabel: (() => srcMeta.appLabel) as unknown as string,
    dbTable: (() => field.m2mDbTable()) as unknown as string,
    autoCreated: true,
    uniqueTogether: [[fromName, toName]],
    verboseName: `${srcMeta.objectName}-${tgtMeta.objectName} relationship`,
    verboseNamePlural: `${srcMeta.objectName}-${tgtMeta.objectName} relationships`,
  }
  const fields = {
    [fromName]: new ForeignKey(src, { onDelete: CASCADE, relatedName: `${name}+`, dbConstraint: field.dbConstraint }),
    [toName]: new ForeignKey(target, { onDelete: CASCADE, relatedName: `${name}+`, dbConstraint: field.dbConstraint }),
  }
  const through = createModelClass(name, fields, { meta, registry: srcMeta.registry })
  void through._meta
  return through
}

/** Wire a resolved relation: reverse RelatedObject, reverse accessor, through model. */
function finalizeRelation(field: RelatedField<any, any>, target: ModelClass): void {
  field.resolvedTarget = target
  if (field.remoteField) return
  const targetMeta = target._meta
  if (targetMeta.abstract) {
    throw new ImproperlyConfigured(
      `Field ${String(field)} defines a relation with model '${targetMeta.objectName}', which is either not installed, or is abstract.`,
    )
  }
  if (field instanceof ManyToManyField && !field.throughModel) {
    field.throughModel = field.options.through !== undefined ? resolveTarget(field, field.options.through) : createAutoThrough(field, target)
    void field.throughModel._meta
    const srcMeta = field.model._meta
    if (srcMeta.hasAppLabel && srcMeta.registry.getModels(srcMeta.appLabel).includes(field.model) && field.throughModel._meta.autoCreated) {
      srcMeta.registry.register(srcMeta.appLabel, field.throughModel)
    }
  }
  const rel = new RelatedObject(field, target)
  field.remoteField = rel
  targetMeta._relatedObjects.push(rel)
  installReverseDescriptor(target, rel)
}

setRelationResolver((field) => {
  if (!field.model) throw new TypeError(`Relation field '${field.name || '?'}' isn't bound to a model yet.`)
  const target = resolveTarget(field, field.to)
  try {
    finalizeRelation(field, target)
  } catch (e) {
    field.resolvedTarget = undefined
    throw e
  }
  field.model._meta.registry.pending.delete(field)
  return target
})

setRegistryHooks({
  resolveField(field) {
    if (field.remoteField) return true
    try {
      void field.relatedModel
      return true
    } catch (e) {
      if (e instanceof ImproperlyConfigured && /abstract|clashes/.test(e.message)) throw e
      field.resolvedTarget = undefined
      return false
    }
  },
})

// Assign app labels when apps are populated: every Model class in an AppConfig's `models`.
globalSingleton('ghuri.orm.populateHook', () => {
  apps.onPopulate(async (registry) => {
    for (const config of registry.getAppConfigs()) {
      if (config.models) registerModels(config.appLabel, config.models)
    }
    for (const m of modelRegistry.all) {
      if (m._meta.autoCreated && m._meta.hasAppLabel) {
        try {
          modelRegistry.register(m._meta.appLabel, m)
        } catch {}
      }
    }
    modelRegistry.checkPending()
  })
  return true
})
