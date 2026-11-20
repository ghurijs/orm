// Swappable models (Django's `Meta.swappable` / `settings.AUTH_USER_MODEL`): reading the setting that names the
// model in use, and finding the model that declares a swappable setting.
import { ImproperlyConfigured, LookupError, tryGetContext } from '@ghuri/core'
import { isModelClass, modelRegistry } from './registry'
import type { ModelClass } from './types'

/**
 * The current value of a swappable setting: `'AUTH_USER_MODEL'` reads `settings.AUTH_USER_MODEL`, a dotted path
 * (`'AGENTS.CONVERSATION_MODEL'`) reads a nested setting. Undefined outside a Ghuri context or when unset.
 */
export function readSwappableSetting(setting: string): unknown {
  let value: unknown = tryGetContext()?.settings
  for (const part of setting.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** The (non-historical) model that declares `Meta.swappable = setting`, if one has been prepared. */
function declaringModel(setting: string): ModelClass | undefined {
  for (const m of modelRegistry.all) if (m._meta.meta.swappable === setting) return m
  return undefined
}

/**
 * The `'app_label.ModelName'` a swappable setting resolves to: the setting's value, else the label of the model
 * declaring it (`Meta.swappable`), else `defaultLabel`. Throws `ImproperlyConfigured` when none is known.
 */
export function getSwappableLabel(setting: string, defaultLabel?: string): string {
  const value = readSwappableSetting(setting)
  if (typeof value === 'string' && value) return value
  if (value !== undefined && value !== null && value !== '')
    throw new ImproperlyConfigured(`${setting} must be of the form 'app_label.model_name'.`)
  const declared = declaringModel(setting)
  if (declared?._meta.hasAppLabel) return declared._meta.label
  if (defaultLabel) return defaultLabel
  throw new ImproperlyConfigured(
    `${setting} is not set and no installed model declares Meta.swappable = '${setting}'.`,
  )
}

/**
 * The model a swappable setting names (Django's `get_user_model()`, generalised): `getSwappableModel(
 * 'AGENTS.CONVERSATION_MODEL', 'agents.Conversation')`. Throws `ImproperlyConfigured` when the setting is malformed
 * or names a model that is not installed.
 */
export function getSwappableModel<M extends ModelClass = ModelClass>(
  setting: string,
  defaultLabel?: string,
): M {
  const label = getSwappableLabel(setting, defaultLabel)
  if (!/^[^.]+\.[^.]+$/.test(label))
    throw new ImproperlyConfigured(`${setting} must be of the form 'app_label.model_name'.`)
  let model: unknown
  try {
    model = modelRegistry.getModel(label)
  } catch (err) {
    if (err instanceof LookupError)
      throw new ImproperlyConfigured(`${setting} refers to model '${label}' that has not been installed.`)
    throw err
  }
  if (!isModelClass(model)) throw new ImproperlyConfigured(`${setting} '${label}' is not a model.`)
  return model as M
}
