import { Signal } from '@ghuri/core'
import type { BaseModel, ModelClass } from './models/types'
import { globalSingleton } from './utils'

export interface SaveSignalArgs {
  instance: BaseModel
  raw: boolean
  using: string
  updateFields?: string[] | null
}
export interface PostSaveSignalArgs extends SaveSignalArgs {
  created: boolean
}
export interface DeleteSignalArgs {
  instance: BaseModel
  using: string
  origin: unknown
}
export type M2MAction = 'pre_add' | 'post_add' | 'pre_remove' | 'post_remove' | 'pre_clear' | 'post_clear'
export interface M2MChangedArgs {
  instance: BaseModel
  action: M2MAction
  /** true when changed from the reverse side (`tag.posts.add(post)`). */
  reverse: boolean
  /** The class of the objects added/removed. */
  model: ModelClass
  pkSet: Set<unknown> | null
  using: string
}

interface OrmSignals {
  preSave: Signal<SaveSignalArgs>
  postSave: Signal<PostSaveSignalArgs>
  preDelete: Signal<DeleteSignalArgs>
  postDelete: Signal<DeleteSignalArgs>
  m2mChanged: Signal<M2MChangedArgs>
  preInit: Signal<{ data: Record<string, unknown> | undefined }>
  postInit: Signal<{ instance: BaseModel }>
}

// One set of signals per process even with duplicate module instances.
const signals: OrmSignals = globalSingleton('ghuri.orm.signals', () => ({
  preSave: new Signal<SaveSignalArgs>('preSave'),
  postSave: new Signal<PostSaveSignalArgs>('postSave'),
  preDelete: new Signal<DeleteSignalArgs>('preDelete'),
  postDelete: new Signal<DeleteSignalArgs>('postDelete'),
  m2mChanged: new Signal<M2MChangedArgs>('m2mChanged'),
  preInit: new Signal<{ data: Record<string, unknown> | undefined }>('preInit'),
  postInit: new Signal<{ instance: BaseModel }>('postInit'),
}))

/** Sent before `instance.save()` writes (sender: model class). */
export const preSave = signals.preSave
/** Sent after `instance.save()`; `created` tells insert from update. */
export const postSave = signals.postSave
/** Sent for every object deleted by `instance.delete()` / `qs.delete()` (incl. cascades). */
export const preDelete = signals.preDelete
export const postDelete = signals.postDelete
/** Sent by M2M related managers (`add/remove/clear/set`); sender is the through model. */
export const m2mChanged = signals.m2mChanged

/** Arguments of `preMigrate` / `postMigrate` (sender: the AppConfig). */
export interface MigrateSignalArgs {
  appConfig: import('@ghuri/core').AppConfig
  /** Database alias. */
  using: string
  /** Plan that ran (or will run): `{ migration, backwards }` entries; empty for `flush`. */
  plan: Array<{ migration: { appLabel: string; name: string }; backwards: boolean }>
}

const migrateSignals = globalSingleton('ghuri.orm.migrateSignals', () => ({
  preMigrate: new Signal<MigrateSignalArgs>('preMigrate'),
  postMigrate: new Signal<MigrateSignalArgs>('postMigrate'),
}))

/** Sent for every installed app before `migrate` runs its plan (Django's `pre_migrate`). */
export const preMigrate: Signal<MigrateSignalArgs> = migrateSignals.preMigrate
/**
 * Sent for every installed app after `migrate` (and `flush`) finished (Django's `post_migrate`); `@ghuri/auth`
 * creates default permissions here.
 */
export const postMigrate: Signal<MigrateSignalArgs> = migrateSignals.postMigrate
