// dumpdata / loaddata / flush / copydata — Django-compatible JSON fixtures, Workers-safe (no file access).
import { apps } from '@ghuri/core'
import { atomic, connections, DEFAULT_DB_ALIAS } from './db/connections'
import type { Connection } from './db/types'
import type { Field } from './fields/base'
import { ForeignKey, type ManyToManyField } from './fields/related'
import { PostgresSchemaEditor } from './migrations/schema/postgresql'
import { isAbstractModel } from './models/base'
import { isModelClass, modelRegistry } from './models/registry'
import type { BaseModel, ModelClass } from './models/types'
import { type Dialect, ident, quoteName, Sql } from './query/sql'
import { postMigrate, postSave, preSave } from './signals'

/** One fixture object: `{ model: 'blog.post', pk: 1, fields: { title: 'Hi', author: 3, tags: [1, 2] } }`. */
export interface FixtureObject {
  model: string
  pk?: unknown
  fields: Record<string, unknown>
}

function installedModels(): ModelClass[] {
  const out: ModelClass[] = []
  const seen = new Set<ModelClass>()
  for (const m of apps.getModels() as unknown[]) {
    if (!isModelClass(m) || isAbstractModel(m) || seen.has(m)) continue
    seen.add(m)
    out.push(m)
  }
  return out
}

/** Models (and auto-created through models) ordered so FK targets come before referencing models. */
export function sortModelsByDependencies(models: ModelClass[]): ModelClass[] {
  const set = new Set(models)
  const out: ModelClass[] = []
  const done = new Set<ModelClass>()
  const visiting = new Set<ModelClass>()
  const visit = (m: ModelClass) => {
    if (done.has(m) || visiting.has(m)) return
    visiting.add(m)
    for (const f of m._meta.concreteFields) {
      if (!(f instanceof ForeignKey)) continue
      const t = f.relatedModel
      if (t !== m && set.has(t)) visit(t)
    }
    visiting.delete(m)
    done.add(m)
    out.push(m)
  }
  for (const m of models) visit(m)
  return out
}

/** Resolve `app` / `app.Model` labels to models (all installed models when empty). */
export function resolveModelLabels(labels: string[] = [], exclude: string[] = []): ModelClass[] {
  const all = installedModels().filter((m) => !m._meta.autoCreated && m._meta.managed)
  let chosen: ModelClass[]
  if (!labels.length) chosen = all
  else {
    chosen = []
    for (const l of labels) {
      if (l.includes('.')) chosen.push(modelRegistry.getModel(l))
      else {
        if (!apps.isInstalled(l)) throw new Error(`No installed app with label '${l}'.`)
        chosen.push(...all.filter((m) => m._meta.appLabel === l))
      }
    }
  }
  const ex = new Set(exclude.map((e) => e.toLowerCase()))
  return [...new Set(chosen)].filter(
    (m) => !ex.has(m._meta.appLabel.toLowerCase()) && !ex.has(m._meta.labelLower),
  )
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** JSON-ready value of a field (Django's `value_to_string` semantics). */
export function serializeFieldValue(_field: Field<any, any>, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return base64(value)
  if (typeof value === 'bigint') return Number(value)
  return value
}

export interface DumpDataOptions {
  /** `app` or `app.Model` labels (default: every installed model). */
  labels?: string[]
  /** `app` or `app.Model` labels to leave out. */
  exclude?: string[]
  /** Database alias (`--database`). */
  using?: string
}

/** Serialize database rows to Django-compatible fixture objects (`dumpdata`). M2M values are pk lists. */
export async function dumpData(opts: DumpDataOptions = {}): Promise<FixtureObject[]> {
  const using = opts.using ?? DEFAULT_DB_ALIAS
  const conn = await connections.get(using)
  const models = sortModelsByDependencies(resolveModelLabels(opts.labels, opts.exclude))
  const out: FixtureObject[] = []
  for (const model of models) {
    const meta = model._meta
    const m2m = meta.localManyToMany.filter((f) => f.through._meta.autoCreated)
    const m2mValues = new Map<string, Map<unknown, unknown[]>>()
    for (const f of m2m) m2mValues.set(f.name, await throughPairs(conn, f))
    const rows = (await model._baseManager.using(using).orderBy('pk')) as BaseModel[]
    for (const obj of rows) {
      const fields: Record<string, unknown> = {}
      for (const f of meta.concreteFields) {
        if (f.primaryKey || !f.serialize) continue
        fields[f.name] = serializeFieldValue(f, (obj as any)[f.attname])
      }
      for (const f of m2m) {
        const pk = obj.pk
        fields[f.name] = (m2mValues.get(f.name)!.get(pk) ?? []).map((v) => serializeFieldValue(f, v))
      }
      out.push({ model: meta.labelLower, pk: serializeFieldValue(meta.pk, obj.pk), fields })
    }
  }
  return out
}

/** `source pk → target pks` of an auto-created M2M table. */
async function throughPairs(conn: Connection, field: ManyToManyField): Promise<Map<unknown, unknown[]>> {
  const through = field.through
  const [srcName, tgtName] = field.throughFieldNames()
  const src = through._meta.getForwardField(srcName) as ForeignKey
  const tgt = through._meta.getForwardField(tgtName) as ForeignKey
  const res = await conn.execute(
    `SELECT ${quoteName(src.column)} AS s, ${quoteName(tgt.column)} AS t FROM ${quoteName(through._meta.dbTable)} ORDER BY ${quoteName(through._meta.pk.column)}`,
  )
  const map = new Map<unknown, unknown[]>()
  for (const r of res.rows) {
    const s = src.fromDb(r.s, conn.dialect)
    const t = tgt.fromDb(r.t, conn.dialect)
    const list = map.get(s) ?? []
    list.push(t)
    map.set(s, list)
  }
  return map
}

export interface LoadDataOptions {
  using?: string
}

export interface LoadDataResult {
  objects: number
  models: number
}

function lookupModel(label: string): ModelClass {
  return modelRegistry.getModel(label)
}

/** Insert or update (by pk) one row; returns the statement. */
function upsertStatement(
  model: ModelClass,
  values: Array<[Field<any, any>, unknown]>,
  dialect: Dialect,
  hasPk: boolean,
): { sql: string; params: unknown[] } {
  const meta = model._meta
  const cols = values.map(([f]) => ident(f.column))
  const vals = values.map(([f, v]) =>
    v === null || v === undefined ? Sql.raw('NULL') : f.dbParam(v, dialect),
  )
  const q = new Sql(['INSERT INTO '])
    .append(ident(meta.dbTable))
    .append(' (')
    .append(Sql.join(cols))
    .append(') VALUES (')
    .append(Sql.join(vals))
    .append(')')
  const updates = values.filter(([f]) => !f.primaryKey)
  if (hasPk) {
    q.append(' ON CONFLICT (').append(ident(meta.pk.column)).append(') ')
    if (updates.length)
      q.append('DO UPDATE SET ').append(
        Sql.join(
          updates.map(([f]) =>
            new Sql().append(ident(f.column)).append(' = excluded.').append(ident(f.column)),
          ),
        ),
      )
    else q.append('DO NOTHING')
  }
  return q.render(dialect)
}

/**
 * Load fixture objects into a database (`loaddata`): rows are upserted by pk in dependency order inside one
 * transaction (one batch on D1), M2M tables are replaced, PostgreSQL sequences are reset afterwards.
 * `preSave` / `postSave` are sent with `raw: true` when they have receivers.
 */
export async function loadData(
  objects: FixtureObject[],
  opts: LoadDataOptions = {},
): Promise<LoadDataResult> {
  const using = opts.using ?? DEFAULT_DB_ALIAS
  const conn = await connections.get(using)
  const dialect = conn.dialect
  const grouped = new Map<ModelClass, FixtureObject[]>()
  for (const obj of objects) {
    if (!obj || typeof obj.model !== 'string')
      throw new Error(`Invalid fixture object: ${JSON.stringify(obj)}`)
    const model = lookupModel(obj.model)
    const list = grouped.get(model) ?? []
    list.push(obj)
    grouped.set(model, list)
  }
  const order = sortModelsByDependencies([...grouped.keys()])
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const instances: Array<[ModelClass, BaseModel]> = []
  const throughTables = new Set<ModelClass>()
  for (const model of order) {
    const meta = model._meta
    for (const obj of grouped.get(model)!) {
      const values: Array<[Field<any, any>, unknown]> = []
      const raw: Record<string, unknown> = {}
      const hasPk = obj.pk !== undefined && obj.pk !== null
      const pk = hasPk ? meta.pk.toPython(obj.pk) : undefined
      if (hasPk) {
        values.push([meta.pk, pk])
        raw[meta.pk.attname] = pk
      }
      for (const f of meta.concreteFields) {
        if (f.primaryKey) continue
        let v: unknown
        if (f.name in obj.fields) v = obj.fields[f.name]
        else if (f.attname in obj.fields) v = obj.fields[f.attname]
        else v = f.getDefault()
        // JSON values are taken as they are (toPython would parse JSON strings).
        if (v !== null && v !== undefined && f.internalType !== 'JSONField') v = f.toPython(v)
        values.push([f, v])
        raw[f.attname] = v
      }
      statements.push(upsertStatement(model, values, dialect, hasPk))
      if (hasPk) {
        for (const m2m of meta.localManyToMany) {
          if (!(m2m.name in obj.fields)) continue
          const through = m2m.through
          if (!through._meta.autoCreated) continue
          throughTables.add(through)
          const [srcName, tgtName] = m2m.throughFieldNames()
          const src = through._meta.getForwardField(srcName) as ForeignKey
          const tgt = through._meta.getForwardField(tgtName) as ForeignKey
          const del = new Sql(['DELETE FROM '])
            .append(ident(through._meta.dbTable))
            .append(' WHERE ')
            .append(ident(src.column))
            .append(' = ')
            .append(src.dbParam(pk, dialect))
          statements.push(del.render(dialect))
          for (const target of (obj.fields[m2m.name] as unknown[] | null) ?? []) {
            const ins = new Sql(['INSERT INTO '])
              .append(ident(through._meta.dbTable))
              .append(' (')
              .append(Sql.join([ident(src.column), ident(tgt.column)]))
              .append(') VALUES (')
              .append(Sql.join([src.dbParam(pk, dialect), tgt.dbParam(tgt.toPython(target), dialect)]))
              .append(')')
            statements.push(ins.render(dialect))
          }
        }
      }
      if (preSave.hasListeners(model) || postSave.hasListeners(model))
        instances.push([model, (model as any)._fromDb(raw, [], using) as BaseModel])
    }
  }

  for (const [model, instance] of instances)
    await preSave.send(model, { instance, raw: true, using, updateFields: null })
  if (conn.supportsTransactions) {
    await atomic(
      async () => {
        const tx = await connections.get(using)
        if (dialect === 'sqlite') await tx.execute('PRAGMA defer_foreign_keys = ON')
        for (const s of statements) await tx.execute(s.sql, s.params)
      },
      { using },
    )
  } else if (conn.batch) {
    // D1: one atomic batch (chunked for very large fixtures).
    const CHUNK = 5000
    for (let i = 0; i < statements.length; i += CHUNK) {
      const chunk = statements.slice(i, i + CHUNK)
      await conn.batch([{ sql: 'PRAGMA defer_foreign_keys = ON', params: [] }, ...chunk])
    }
  } else {
    for (const s of statements) await conn.execute(s.sql, s.params)
  }
  if (dialect === 'postgresql') await resetSequences(conn, [...order, ...throughTables])
  for (const [model, instance] of instances)
    await postSave.send(model, { instance, raw: true, using, updateFields: null, created: true })
  return { objects: objects.length, models: grouped.size }
}

/** PostgreSQL: move identity sequences past the highest id (after inserting explicit ids). */
export async function resetSequences(conn: Connection, models: ModelClass[]): Promise<void> {
  if (conn.dialect !== 'postgresql') return
  const editor = new PostgresSchemaEditor(conn)
  for (const m of models) {
    const sql = editor.sequenceResetSql(m)
    if (sql) await conn.execute(sql)
  }
}

export interface FlushOptions {
  using?: string
  /** Don't send postMigrate afterwards. */
  inhibitPostMigrate?: boolean
}

/** Delete every row of every installed model (and M2M tables); reset sequences (`flush`). */
export async function flushDatabase(opts: FlushOptions = {}): Promise<string[]> {
  const using = opts.using ?? DEFAULT_DB_ALIAS
  const conn = await connections.get(using)
  const models = installedModels().filter((m) => m._meta.managed && !m._meta.autoCreated)
  const all = new Set<ModelClass>()
  for (const m of models) {
    all.add(m)
    for (const f of m._meta.localManyToMany) if (f.through._meta.autoCreated) all.add(f.through)
  }
  const ordered = sortModelsByDependencies([...all]).reverse()
  const tables = ordered.map((m) => m._meta.dbTable)
  const existing = new Set(
    (
      await conn.execute(
        conn.dialect === 'postgresql'
          ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()'
          : "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
    ).rows.map((r) => String(r.name)),
  )
  const present = tables.filter((t) => existing.has(t))
  if (present.length) {
    if (conn.dialect === 'postgresql') {
      await conn.execute(`TRUNCATE ${present.map(quoteName).join(', ')} RESTART IDENTITY CASCADE`)
    } else {
      const stmts = [
        { sql: 'PRAGMA defer_foreign_keys = ON', params: [] as unknown[] },
        ...present.map((t) => ({ sql: `DELETE FROM ${quoteName(t)}`, params: [] as unknown[] })),
      ]
      if (existing.has('sqlite_sequence'))
        stmts.push({
          sql: `DELETE FROM sqlite_sequence WHERE name IN (${present.map(() => '?').join(', ')})`,
          params: present,
        })
      if (conn.batch) await conn.batch(stmts)
      else for (const s of stmts) await conn.execute(s.sql, s.params)
    }
  }
  if (!opts.inhibitPostMigrate)
    for (const appConfig of apps.getAppConfigs())
      await postMigrate.send(appConfig, { appConfig, using, plan: [] })
  return present
}

export interface CopyDataOptions {
  /** Source alias. */
  from: string
  /** Destination alias (must be migrated already: `migrate --database <to>`). */
  to: string
  labels?: string[]
  exclude?: string[]
  /** Flush the destination first. */
  flush?: boolean
}

/** Copy rows between two databases in-process (dumpdata + loaddata): the D1 → Postgres move. */
export async function copyData(opts: CopyDataOptions): Promise<LoadDataResult> {
  const objects = await dumpData({ using: opts.from, labels: opts.labels, exclude: opts.exclude })
  if (opts.flush) await flushDatabase({ using: opts.to, inhibitPostMigrate: true })
  return loadData(objects, { using: opts.to })
}
