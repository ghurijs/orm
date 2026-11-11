import type { CommandIO } from '@ghuri/core'
import type { FieldDeconstruction } from '../fields/base'
import { IGNORE, type MigrationQuestioner, NonInteractiveQuestioner } from './autodetector'
import { MigrationQuestionError } from './errors'
import type { ModelState } from './state'

/** Parse a one-off default typed by the user: JSON, `now`, or a plain string. */
export function parseDefaultAnswer(answer: string, field?: FieldDeconstruction): unknown {
  const a = answer.trim()
  if (a === 'now' || a === 'now()') {
    const d = new Date()
    if (field?.type === 'DateField') return d.toISOString().slice(0, 10)
    if (field?.type === 'TimeField') return d.toISOString().slice(11, 19)
    return d
  }
  try {
    return JSON.parse(a)
  } catch {
    return a
  }
}

/** Asks on the terminal through `CommandIO.confirm` / `prompt` (Django's `InteractiveMigrationQuestioner`). */
export class InteractiveQuestioner implements MigrationQuestioner {
  private readonly fallback = new NonInteractiveQuestioner()

  constructor(readonly io: CommandIO) {}

  private async confirm(q: string, def = false): Promise<boolean> {
    if (this.io.confirm) return this.io.confirm(q, { default: def })
    if (this.io.prompt) {
      const a = (await this.io.prompt(`${q} [y/N] `)).trim().toLowerCase()
      return a === 'y' || a === 'yes'
    }
    return def
  }

  async askRenameModel(oldModel: ModelState, newModel: ModelState): Promise<boolean> {
    if (!this.io.confirm && !this.io.prompt) return this.fallback.askRenameModel()
    return this.confirm(`Was the model ${oldModel.label} renamed to ${newModel.name}?`)
  }

  async askRenameField(
    model: ModelState,
    oldName: string,
    newName: string,
    field: FieldDeconstruction,
  ): Promise<boolean> {
    if (!this.io.confirm && !this.io.prompt) return this.fallback.askRenameField()
    return this.confirm(`Was ${model.name}.${oldName} renamed to ${model.name}.${newName} (a ${field.type})?`)
  }

  private async askDefault(
    intro: string,
    field: FieldDeconstruction,
    allowIgnore: boolean,
  ): Promise<unknown> {
    const prompt = this.io.prompt!
    this.io.stdout(intro)
    this.io.stdout('Please select a fix:')
    this.io.stdout(' 1) Provide a one-off default now (will be set on all existing rows)')
    if (allowIgnore)
      this.io.stdout(
        ' 2) Ignore for now (existing NULL rows will make the migration fail; handle them with RunCode/RunSQL)',
      )
    this.io.stdout(
      ` ${allowIgnore ? 3 : 2}) Quit and add a default (or null: true) to the field in models.ts`,
    )
    for (;;) {
      const choice = (await prompt('Select an option: ')).trim()
      if (choice === '1') {
        const answer = await prompt(
          'Please enter the default value as JSON (e.g. "text", 0, true, {}) or \'now\' for the current date/time: ',
        )
        return parseDefaultAnswer(answer, field)
      }
      if (allowIgnore && choice === '2') return IGNORE
      if (choice === (allowIgnore ? '3' : '2'))
        throw new MigrationQuestionError('Aborted: add a default to the field.')
    }
  }

  async askNotNullAddition(
    model: ModelState,
    fieldName: string,
    field: FieldDeconstruction,
  ): Promise<unknown> {
    if (!this.io.prompt) return this.fallback.askNotNullAddition(model, fieldName)
    return this.askDefault(
      `It is impossible to add a non-nullable field '${fieldName}' to ${model.name.toLowerCase()} without specifying a default. ` +
        'This is because the database needs something to populate existing rows.',
      field,
      false,
    )
  }

  async askNotNullAlteration(
    model: ModelState,
    fieldName: string,
    field: FieldDeconstruction,
  ): Promise<unknown> {
    if (!this.io.prompt) return this.fallback.askNotNullAlteration(model, fieldName)
    return this.askDefault(
      `It is impossible to change a nullable field '${fieldName}' on ${model.name.toLowerCase()} to non-nullable without providing a default. ` +
        'This is because the database needs something to populate existing NULL rows.',
      field,
      true,
    )
  }

  async askMerge(app: string, leaves: string[]): Promise<boolean> {
    if (!this.io.confirm && !this.io.prompt) return true
    return this.confirm(`Merge ${leaves.join(', ')} in app '${app}'?`, true)
  }
}
