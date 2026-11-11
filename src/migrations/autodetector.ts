import type { FieldDeconstruction } from '../fields/base'
import { fieldFromSpec } from '../fields/index'
import type { ConstraintSpec, IndexSpec, ModelClass } from '../models/types'
import { InvalidMigrationPlan, MigrationQuestionError } from './errors'
import type { MigrationGraph } from './graph'
import { Migration } from './migration'
import {
  AddConstraint,
  AddField,
  AddIndex,
  AlterField,
  AlterModelOptions,
  AlterModelTable,
  AlterUniqueTogether,
  CreateModel,
  DeleteModel,
  type Operation,
  RemoveConstraint,
  RemoveField,
  RemoveIndex,
  RenameField,
  RenameModel,
} from './operations'
import {
  ALTER_OPTION_KEYS,
  canonicalJson,
  fieldSpecsEqual,
  flattenFieldSpec,
  type ModelState,
  ProjectState,
} from './state'

/** Returned by `askNotNullAlteration` to leave existing NULLs alone (the migration may fail on them). */
export const IGNORE: unique symbol = Symbol('ghuri.migrations.ignore') as any

/** Answers the autodetector's questions (Django's `MigrationQuestioner`). */
export interface MigrationQuestioner {
  /** Was `oldModel` renamed to `newModel`? */
  askRenameModel(oldModel: ModelState, newModel: ModelState): Promise<boolean>
  /** Was field `oldName` of `model` renamed to `newName`? */
  askRenameField(
    model: ModelState,
    oldName: string,
    newName: string,
    field: FieldDeconstruction,
  ): Promise<boolean>
  /** One-off default for existing rows when adding a NOT NULL field without default (throw to abort). */
  askNotNullAddition(model: ModelState, fieldName: string, field: FieldDeconstruction): Promise<unknown>
  /** One-off default for existing NULLs when a field becomes NOT NULL, or `IGNORE`. */
  askNotNullAlteration(model: ModelState, fieldName: string, field: FieldDeconstruction): Promise<unknown>
  /** Create a merge migration for `app`? */
  askMerge?(app: string, leaves: string[]): Promise<boolean>
}

/** Answers without asking: no renames, refuses NOT NULL additions without default (Django `--noinput`). */
export class NonInteractiveQuestioner implements MigrationQuestioner {
  readonly warnings: string[] = []
  constructor(
    readonly opts: {
      /** Answers by `'app.Model.field'` for NOT NULL additions/alterations. */
      defaults?: Record<string, unknown>
      /** Accept every rename suggestion. */
      renames?: boolean
    } = {},
  ) {}

  async askRenameModel(): Promise<boolean> {
    return this.opts.renames ?? false
  }

  async askRenameField(): Promise<boolean> {
    return this.opts.renames ?? false
  }

  async askNotNullAddition(model: ModelState, fieldName: string): Promise<unknown> {
    const key = `${model.label}.${fieldName}`
    if (this.opts.defaults && key in this.opts.defaults) return this.opts.defaults[key]
    throw new MigrationQuestionError(
      `It is impossible to add the field '${fieldName}' to ${model.name.toLowerCase()} without specifying a default. ` +
        'This is because the database needs something to populate existing rows. Add a default (or null: true) ' +
        'to the field, or run makemigrations interactively to provide a one-off default.',
    )
  }

  async askNotNullAlteration(model: ModelState, fieldName: string): Promise<unknown> {
    const key = `${model.label}.${fieldName}`
    if (this.opts.defaults && key in this.opts.defaults) return this.opts.defaults[key]
    this.warnings.push(
      `Field '${fieldName}' on model '${model.name.toLowerCase()}' changed from nullable to non-nullable without a default; ` +
        'existing NULL rows will make the migration fail.',
    )
    return IGNORE
  }

  async askMerge(): Promise<boolean> {
    return true
  }
}

interface GenOp {
  app: string
  op: Operation
  provides: string[]
  requires: string[]
}

export interface AutodetectorChangesOptions {
  /** Only return migrations for these apps (plus apps they need). */
  trimToApps?: string[]
  /** Apps without migrations whose models should get an initial migration. */
  convertApps?: string[]
  /** Use this name (after the number) for generated migrations. */
  migrationName?: string
}

const TIME_TYPES = new Set(['DateField', 'DateTimeField', 'TimeField'])

function isRelationSpec(spec: FieldDeconstruction): boolean {
  return typeof spec.options.to === 'string'
}

function targetKey(spec: FieldDeconstruction, appLabel: string, modelName: string): string | null {
  const to = spec.options.to
  if (typeof to !== 'string') return null
  if (to === 'self') return `${appLabel}.${modelName.toLowerCase()}`
  return (to.includes('.') ? to : `${appLabel}.${to}`).toLowerCase()
}

function throughKey(spec: FieldDeconstruction, appLabel: string): string | null {
  const t = spec.options.through
  if (typeof t !== 'string') return null
  return (t.includes('.') ? t : `${appLabel}.${t}`).toLowerCase()
}

function appOfEvent(ev: string): string {
  const body = ev.slice(ev.indexOf(':') + 1)
  return body.slice(0, body.indexOf('.'))
}

/** Can `value` be written into a migration file as a literal? */
function serializable(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (value instanceof Date || value instanceof Uint8Array) return true
  if (Array.isArray(value)) return value.every(serializable)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.values(value).every(serializable)
  return false
}

/**
 * Compares two project states and produces the migrations that turn one into the other (Django's
 * `MigrationAutodetector`): model / field creation, deletion, renames (asked), alterations, M2M, indexes,
 * constraints, `uniqueTogether`, table and options changes, with dependencies between apps.
 */
export class MigrationAutodetector {
  private working: ProjectState
  private ops: GenOp[] = []

  constructor(
    readonly fromState: ProjectState,
    readonly toState: ProjectState,
    readonly questioner: MigrationQuestioner = new NonInteractiveQuestioner(),
    /** Live model classes by `app.model` key (to evaluate callable defaults once). */
    readonly liveModels: Map<string, ModelClass> = new Map(),
  ) {
    this.working = fromState.clone()
  }

  /** The new migrations per app, numbered after the existing ones in `graph`. */
  async changes(
    graph: MigrationGraph,
    opts: AutodetectorChangesOptions = {},
  ): Promise<Map<string, Migration[]>> {
    await this.detect(new Set(opts.convertApps ?? []))
    const migrations = this.arrange(graph)
    if (opts.trimToApps?.length) this.trimToApps(migrations, new Set(opts.trimToApps))
    this.name(graph, migrations, opts.migrationName)
    return migrations
  }

  // ---- detection --------------------------------------------------------------------------------

  private keys(state: ProjectState, convert: Set<string>): Set<string> {
    const out = new Set<string>()
    for (const [k, ms] of state.models) {
      if (this.fromState.realApps.has(ms.appLabel) && !convert.has(ms.appLabel)) continue
      out.add(k)
    }
    return out
  }

  private add(op: Operation, app: string, provides: string[] = [], requires: string[] = []): void {
    this.ops.push({ app, op, provides, requires: [...new Set(requires)] })
  }

  private async detect(convert: Set<string>): Promise<void> {
    const to = this.toState
    let oldKeys = this.keys(this.working, convert)
    const newKeys = this.keys(to, convert)

    // 1. renamed models
    const added = [...newKeys].filter((k) => !oldKeys.has(k)).sort()
    const removed = [...oldKeys].filter((k) => !newKeys.has(k)).sort()
    for (const nk of added) {
      const nm = to.models.get(nk)!
      for (const ok of removed) {
        if (!oldKeys.has(ok)) continue
        const om = this.working.models.get(ok)!
        if (om.appLabel !== nm.appLabel || !this.sameFields(om, nm)) continue
        if (await this.questioner.askRenameModel(om, nm)) {
          const op = new RenameModel({ oldName: om.name, newName: nm.name })
          op.stateForwards(om.appLabel, this.working)
          this.add(op, om.appLabel, [`model:${nk}`], [])
          oldKeys = this.keys(this.working, convert)
          break
        }
      }
    }

    const createdKeys = [...newKeys].filter((k) => !oldKeys.has(k)).sort()
    const deletedKeys = [...oldKeys].filter((k) => !newKeys.has(k)).sort()
    const keptKeys = [...newKeys].filter((k) => oldKeys.has(k)).sort()

    // 2. renamed fields (kept models)
    for (const k of keptKeys) await this.detectRenamedFields(k)

    // 3. table renames
    for (const k of keptKeys) {
      const om = this.working.models.get(k)!
      const nm = to.models.get(k)!
      if ((om.options.dbTable ?? null) !== (nm.options.dbTable ?? null)) {
        this.add(
          new AlterModelTable({ name: nm.name, table: (nm.options.dbTable as string) ?? null }),
          nm.appLabel,
        )
      }
    }

    // 4. removed constraints / indexes / unique sets
    for (const k of keptKeys) this.detectRemovedIndexesAndConstraints(k)

    // 5. removed fields
    for (const k of keptKeys) {
      const om = this.working.models.get(k)!
      const nm = to.models.get(k)!
      for (const [name] of om.fields) {
        if (nm.fields.has(name)) continue
        this.add(new RemoveField({ modelName: nm.name, name }), nm.appLabel, [`removed:${k}.${name}`])
      }
    }

    // 6. deleted models
    this.detectDeletedModels(deletedKeys, keptKeys)

    // 7. created models
    this.detectCreatedModels(createdKeys)

    // 8. added fields
    for (const k of keptKeys) {
      const om = this.working.models.get(k)!
      const nm = to.models.get(k)!
      for (const [name, spec] of nm.fields) {
        if (om.fields.has(name)) continue
        await this.addFieldOp(nm, name, spec)
      }
    }

    // 9. altered fields
    for (const k of keptKeys) {
      const om = this.working.models.get(k)!
      const nm = to.models.get(k)!
      for (const [name, spec] of nm.fields) {
        const old = om.fields.get(name)
        if (!old || fieldSpecsEqual(old, spec)) continue
        const oldM2M = old.type === 'ManyToManyField'
        const newM2M = spec.type === 'ManyToManyField'
        if (oldM2M !== newM2M) {
          this.add(new RemoveField({ modelName: nm.name, name }), nm.appLabel, [`removed:${k}.${name}`])
          await this.addFieldOp(nm, name, spec)
          continue
        }
        let oneOffDefault: unknown
        if (old.options.null === true && spec.options.null !== true && !newM2M && this.needsDefault(spec)) {
          const v = this.callableDefault(nm, name, spec)
          const answer = v !== undefined ? v : await this.questioner.askNotNullAlteration(nm, name, spec)
          if (answer !== IGNORE) oneOffDefault = answer
        }
        const requires = [`model:${k}`]
        const t = targetKey(spec, nm.appLabel, nm.name)
        if (t) requires.push(`model:${t}`)
        this.add(
          new AlterField({ modelName: nm.name, name, field: flattenFieldSpec(spec) as any, oneOffDefault }),
          nm.appLabel,
          [`field:${k}.${name}`],
          requires,
        )
      }
    }

    // 10. unique together / indexes / constraints added
    for (const k of keptKeys) this.detectAddedIndexesAndConstraints(k)

    // 11. options
    for (const k of keptKeys) {
      const om = this.working.models.get(k)!
      const nm = to.models.get(k)!
      const pick = (ms: ModelState) =>
        Object.fromEntries(
          ALTER_OPTION_KEYS.filter((o) => ms.options[o] !== undefined).map((o) => [o, ms.options[o]]),
        )
      const a = pick(om)
      const b = pick(nm)
      if (canonicalJson(a) !== canonicalJson(b))
        this.add(new AlterModelOptions({ name: nm.name, options: b }), nm.appLabel)
    }
  }

  /** Same fields (names and definitions, relations to itself compared by position). */
  private sameFields(a: ModelState, b: ModelState): boolean {
    if (a.fields.size !== b.fields.size) return false
    const selfA = a.key
    const selfB = b.key
    for (const [name, spec] of a.fields) {
      const other = b.fields.get(name)
      if (!other) return false
      const ta = targetKey(spec, a.appLabel, a.name)
      const tb = targetKey(other, b.appLabel, b.name)
      const strip = (s: FieldDeconstruction, t: string | null, self: string) =>
        t === self ? { ...s, options: { ...s.options, to: 'self' } } : s
      if (!fieldSpecsEqual(strip(spec, ta, selfA), strip(other, tb, selfB))) return false
    }
    return true
  }

  private async detectRenamedFields(k: string): Promise<void> {
    const om = this.working.models.get(k)!
    const nm = this.toState.models.get(k)!
    const added = [...nm.fields.keys()].filter((n) => !om.fields.has(n))
    for (const newName of added) {
      const spec = nm.fields.get(newName)!
      const removed = [...om.fields.keys()].filter((n) => !nm.fields.has(n))
      for (const oldName of removed) {
        const oldSpec = om.fields.get(oldName)!
        const comparable = (s: FieldDeconstruction) => ({
          ...s,
          options: { ...s.options, dbColumn: undefined },
        })
        if (!fieldSpecsEqual(comparable(oldSpec), comparable(spec))) continue
        if (await this.questioner.askRenameField(nm, oldName, newName, spec)) {
          const op = new RenameField({ modelName: nm.name, oldName, newName })
          op.stateForwards(nm.appLabel, this.working)
          this.add(op, nm.appLabel, [`field:${k}.${newName}`, `removed:${k}.${oldName}`], [`model:${k}`])
          // A dbColumn difference becomes an AlterField (detected later).
          break
        }
      }
    }
  }

  private needsDefault(spec: FieldDeconstruction): boolean {
    const o = spec.options
    if (o.null === true || o.default !== undefined || o.dbDefault !== undefined) return false
    if (spec.type === 'ManyToManyField') return false
    if (TIME_TYPES.has(spec.type) && (o.autoNow || o.autoNowAdd)) return false
    if (o.primaryKey) return false
    try {
      const f = fieldFromSpec({ ...spec, options: { ...o, to: 'self' } } as any)
      if (f.isAutoField) return false
      if (f.blank && f.emptyStringsAllowed) return false
    } catch {}
    return true
  }

  /** The live field's callable default evaluated once (for existing rows), when serializable. */
  private callableDefault(ms: ModelState, name: string, spec: FieldDeconstruction): unknown {
    const d = spec.options.default
    if (!d || typeof d !== 'object' || !('callable' in (d as object))) return undefined
    const live = this.liveModels.get(ms.key)
    const field = live?._meta.getForwardField(name)
    if (!field) return undefined
    try {
      const v = field.getDefault()
      return serializable(v) ? v : undefined
    } catch {
      return undefined
    }
  }

  private async addFieldOp(nm: ModelState, name: string, spec: FieldDeconstruction): Promise<void> {
    const k = nm.key
    let oneOffDefault: unknown
    const callable = this.callableDefault(nm, name, spec)
    if (callable !== undefined) oneOffDefault = callable
    else if (
      this.needsDefault(spec) ||
      (spec.options.default &&
        typeof spec.options.default === 'object' &&
        'callable' in (spec.options.default as object) &&
        spec.options.null !== true)
    ) {
      oneOffDefault = await this.questioner.askNotNullAddition(nm, name, spec)
    }
    const requires = [`model:${k}`]
    const t = targetKey(spec, nm.appLabel, nm.name)
    if (t && t !== k) requires.push(`model:${t}`)
    const th = throughKey(spec, nm.appLabel)
    if (th) requires.push(`model:${th}`)
    this.add(
      new AddField({ modelName: nm.name, name, field: flattenFieldSpec(spec) as any, oneOffDefault }),
      nm.appLabel,
      [`field:${k}.${name}`],
      requires,
    )
  }

  private detectRemovedIndexesAndConstraints(k: string): void {
    const om = this.working.models.get(k)!
    const nm = this.toState.models.get(k)!
    const newIdx = new Map(nm.indexes.map((i) => [i.name!, i]))
    for (const idx of om.indexes) {
      const n = newIdx.get(idx.name!)
      if (n && canonicalJson(n) === canonicalJson(idx)) continue
      this.add(new RemoveIndex({ modelName: nm.name, name: idx.name! }), nm.appLabel)
    }
    const newC = new Map(nm.constraints.map((c) => [c.name, c]))
    for (const c of om.constraints) {
      const n = newC.get(c.name)
      if (n && canonicalJson(n) === canonicalJson(c)) continue
      this.add(new RemoveConstraint({ modelName: nm.name, name: c.name }), nm.appLabel)
    }
    const oldUt = om.uniqueTogether
    const newUtKeys = new Set(nm.uniqueTogether.map((s) => JSON.stringify(s)))
    const kept = oldUt.filter((s) => newUtKeys.has(JSON.stringify(s)))
    if (kept.length !== oldUt.length && canonicalJson(oldUt) !== canonicalJson(nm.uniqueTogether)) {
      const op = new AlterUniqueTogether({ name: nm.name, uniqueTogether: kept })
      op.stateForwards(nm.appLabel, this.working)
      this.add(op, nm.appLabel)
    }
  }

  private detectAddedIndexesAndConstraints(k: string): void {
    const om = this.working.models.get(k)!
    const nm = this.toState.models.get(k)!
    const fieldReq = (fields: string[]) => fields.map((f) => `field:${k}.${f.replace(/^-/, '')}`)
    if (canonicalJson(om.uniqueTogether) !== canonicalJson(nm.uniqueTogether)) {
      this.add(
        new AlterUniqueTogether({ name: nm.name, uniqueTogether: nm.uniqueTogether }),
        nm.appLabel,
        [],
        nm.uniqueTogether.flatMap(fieldReq),
      )
    }
    const oldIdx = new Map(om.indexes.map((i) => [i.name!, i]))
    for (const idx of nm.indexes) {
      const o = oldIdx.get(idx.name!)
      if (o && canonicalJson(o) === canonicalJson(idx)) continue
      this.add(
        new AddIndex({ modelName: nm.name, index: idx as IndexSpec }),
        nm.appLabel,
        [],
        fieldReq(idx.fields),
      )
    }
    const oldC = new Map(om.constraints.map((c) => [c.name, c]))
    for (const c of nm.constraints) {
      const o = oldC.get(c.name)
      if (o && canonicalJson(o) === canonicalJson(c)) continue
      this.add(
        new AddConstraint({ modelName: nm.name, constraint: c as ConstraintSpec }),
        nm.appLabel,
        [],
        c.type === 'unique' ? fieldReq(c.fields) : [],
      )
    }
  }

  private detectDeletedModels(deletedKeys: string[], keptKeys: string[]): void {
    const deleted = new Set(deletedKeys)
    for (const k of deletedKeys) {
      const om = this.working.models.get(k)!
      const requires: string[] = []
      for (const other of [...keptKeys, ...deletedKeys]) {
        if (other === k) continue
        const oms = this.working.models.get(other)!
        for (const [name, spec] of oms.fields) {
          const t = targetKey(spec, oms.appLabel, oms.name)
          const th = throughKey(spec, oms.appLabel)
          if (t !== k && th !== k) continue
          requires.push(deleted.has(other) ? `deleted:${other}` : `removed:${other}.${name}`)
        }
      }
      this.add(new DeleteModel({ name: om.name }), om.appLabel, [`deleted:${k}`], requires)
    }
  }

  private detectCreatedModels(createdKeys: string[]): void {
    const created = new Set(createdKeys)
    // Order models of the same app so FK targets come first; break cycles with AddField.
    const order: string[] = []
    const deferredFields = new Map<string, Set<string>>()
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (k: string) => {
      if (state.get(k) === 'done') return
      state.set(k, 'visiting')
      const ms = this.toState.models.get(k)!
      for (const [name, spec] of ms.fields) {
        for (const t of [targetKey(spec, ms.appLabel, ms.name), throughKey(spec, ms.appLabel)]) {
          if (!t || t === k || !created.has(t)) continue
          if (this.toState.models.get(t)!.appLabel !== ms.appLabel) continue
          if (state.get(t) === 'visiting') {
            const set = deferredFields.get(k) ?? new Set()
            set.add(name)
            deferredFields.set(k, set)
          } else visit(t)
        }
      }
      state.set(k, 'done')
      order.push(k)
    }
    for (const k of createdKeys) visit(k)

    const later: Array<() => void> = []
    for (const k of order) {
      const ms = this.toState.models.get(k)!
      const deferred = deferredFields.get(k) ?? new Set()
      const fields: Record<string, any> = {}
      const requires: string[] = []
      const provides = [`model:${k}`]
      for (const [name, spec] of ms.fields) {
        if (deferred.has(name)) {
          later.push(() =>
            this.add(
              new AddField({ modelName: ms.name, name, field: flattenFieldSpec(spec) as any }),
              ms.appLabel,
              [`field:${k}.${name}`],
              [`model:${k}`, `model:${targetKey(spec, ms.appLabel, ms.name)}`],
            ),
          )
          continue
        }
        fields[name] = flattenFieldSpec(spec)
        provides.push(`field:${k}.${name}`)
        const t = targetKey(spec, ms.appLabel, ms.name)
        if (t && t !== k) requires.push(`model:${t}`)
        const th = throughKey(spec, ms.appLabel)
        if (th) requires.push(`model:${th}`)
      }
      const options = { ...ms.options }
      this.add(new CreateModel({ name: ms.name, fields, options }), ms.appLabel, provides, requires)
    }
    for (const f of later) f()
  }

  // ---- arranging into migrations ----------------------------------------------------------------

  /** Stable topological sort of one app's operations by intra-app events. */
  private sortApp(ops: GenOp[]): GenOp[] {
    const producer = new Map<string, number>()
    ops.forEach((o, i) => {
      for (const e of o.provides) if (!producer.has(e)) producer.set(e, i)
    })
    const out: GenOp[] = []
    const done = new Set<number>()
    const visiting = new Set<number>()
    const visit = (i: number) => {
      if (done.has(i) || visiting.has(i)) return
      visiting.add(i)
      for (const r of ops[i].requires) {
        const p = producer.get(r)
        if (p !== undefined && p !== i) visit(p)
      }
      visiting.delete(i)
      done.add(i)
      out.push(ops[i])
    }
    for (let i = 0; i < ops.length; i++) visit(i)
    return out
  }

  private arrange(graph: MigrationGraph): Map<string, Migration[]> {
    const byApp = new Map<string, GenOp[]>()
    for (const o of this.ops) {
      const list = byApp.get(o.app) ?? []
      list.push(o)
      byApp.set(o.app, list)
    }
    for (const [app, list] of byApp) byApp.set(app, this.sortApp(list))
    const producedBy = new Set<string>()
    for (const o of this.ops) for (const e of o.provides) producedBy.add(e)

    const result = new Map<string, Migration[]>()
    const emitted = new Map<string, Migration>()
    const apps = [...byApp.keys()].sort()
    const leafOf = (app: string): [string, string] | null => {
      const gen = result.get(app)
      if (gen?.length) {
        const m = gen[gen.length - 1]
        return [app, m.name]
      }
      const leaves = graph.leafNodes(app)
      return leaves.length ? [leaves[0][0], leaves[0][1]] : null
    }
    let guard = 0
    while ([...byApp.values()].some((l) => l.length)) {
      if (guard++ > 1000)
        throw new InvalidMigrationPlan('Could not resolve migration dependencies (too many iterations).')
      let progress = false
      for (const app of apps) {
        const list = byApp.get(app)!
        if (!list.length) continue
        const chosen: GenOp[] = []
        const internal = new Set<string>()
        const deps: Array<readonly [string, string]> = []
        for (const o of list) {
          let ok = true
          const opDeps: Array<readonly [string, string]> = []
          for (const r of o.requires) {
            if (internal.has(r)) continue
            const rApp = appOfEvent(r)
            if (!producedBy.has(r)) {
              if (rApp !== app) {
                const leaf = graph.leafNodes(rApp)[0]
                if (leaf) opDeps.push([leaf[0], leaf[1]])
              }
              continue
            }
            const m = emitted.get(r)
            if (m) {
              if (m.appLabel !== app) opDeps.push(m.key)
              continue
            }
            ok = false
            break
          }
          if (!ok) break
          chosen.push(o)
          for (const e of o.provides) internal.add(e)
          deps.push(...opDeps)
        }
        if (!chosen.length) continue
        const own = leafOf(app)
        const dependencies: Array<readonly [string, string]> = []
        const seen = new Set<string>()
        for (const d of [...(own ? [own] : []), ...deps]) {
          const s = `${d[0]}.${d[1]}`
          if (seen.has(s)) continue
          seen.add(s)
          dependencies.push(d)
        }
        const migration = new Migration({ dependencies, operations: chosen.map((c) => c.op) })
        migration.appLabel = app
        const list2 = result.get(app) ?? []
        migration.initial = !own && list2.length === 0 ? true : undefined
        migration.name = `__pending_${list2.length}`
        list2.push(migration)
        result.set(app, list2)
        for (const e of internal) emitted.set(e, migration)
        byApp.set(app, list.slice(chosen.length))
        progress = true
      }
      if (!progress) this.breakCycle(byApp, emitted, producedBy)
    }
    return result
  }

  /** Move cross-app FK fields out of a blocked CreateModel into AddField operations right after it. */
  private breakCycle(
    byApp: Map<string, GenOp[]>,
    emitted: Map<string, Migration>,
    producedBy: Set<string>,
  ): void {
    for (const [app, list] of byApp) {
      const first = list[0]
      if (!first || !(first.op instanceof CreateModel)) continue
      const op = first.op
      const k = ProjectState.key(app, op.name)
      const blocked = (r: string) => producedBy.has(r) && !emitted.has(r) && appOfEvent(r) !== app
      if (!first.requires.some(blocked)) continue
      const keep: Record<string, any> = {}
      const extracted: GenOp[] = []
      for (const [name, spec] of Object.entries(op.fields)) {
        const t = targetKey(spec, app, op.name)
        const th = throughKey(spec, app)
        const reqs = [t, th].filter((x): x is string => !!x && x !== k).map((x) => `model:${x}`)
        if (isRelationSpec(spec) && reqs.some(blocked)) {
          extracted.push({
            app,
            op: new AddField({ modelName: op.name, name, field: flattenFieldSpec(spec) as any }),
            provides: [`field:${k}.${name}`],
            requires: [`model:${k}`, ...reqs],
          })
        } else keep[name] = flattenFieldSpec(spec)
      }
      const created = new CreateModel({ name: op.name, fields: keep, options: op.options })
      const remainingReqs = first.requires.filter((r) => !blocked(r))
      const provides = first.provides.filter((p) => !extracted.some((e) => e.provides.includes(p)))
      byApp.set(app, [
        { app, op: created, provides, requires: remainingReqs },
        ...extracted,
        ...list.slice(1),
      ])
      return
    }
    throw new InvalidMigrationPlan('Circular dependency between apps that cannot be resolved automatically.')
  }

  private trimToApps(migrations: Map<string, Migration[]>, apps: Set<string>): void {
    const needed = new Set(apps)
    let changed = true
    while (changed) {
      changed = false
      for (const app of needed) {
        for (const m of migrations.get(app) ?? []) {
          for (const [dApp] of m.dependencies) {
            if (!needed.has(dApp) && migrations.has(dApp)) {
              needed.add(dApp)
              changed = true
            }
          }
        }
      }
    }
    for (const app of [...migrations.keys()]) if (!needed.has(app)) migrations.delete(app)
  }

  private name(graph: MigrationGraph, migrations: Map<string, Migration[]>, custom?: string): void {
    const renames = new Map<string, string>()
    for (const [app, list] of migrations) {
      const leaves = graph.leafNodes(app)
      let next = 1
      for (const [, n] of leaves) {
        const num = Number.parseInt(n.split('_')[0], 10)
        if (!Number.isNaN(num)) next = Math.max(next, num + 1)
      }
      for (const [k] of graph.keys) {
        if (!k.startsWith(`${app}.`)) continue
        const num = Number.parseInt(k.slice(app.length + 1).split('_')[0], 10)
        if (!Number.isNaN(num)) next = Math.max(next, num + 1)
      }
      for (const m of list) {
        const suffix = custom ? custom : m.suggestName()
        const name = `${String(next).padStart(4, '0')}_${suffix}`
        renames.set(`${app}.${m.name}`, name)
        m.name = name
        next++
      }
    }
    for (const list of migrations.values()) {
      for (const m of list) {
        m.dependencies = m.dependencies.map((d) => {
          const r = renames.get(`${d[0]}.${d[1]}`)
          return r ? ([d[0], r] as const) : d
        })
      }
    }
  }
}
