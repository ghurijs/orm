import { bigint as pgBigint, customType as pgCustomType, integer as pgInteger, jsonb, pgTable, smallint as pgSmallint } from 'drizzle-orm/pg-core'
import { customType as sqliteCustomType, integer as sqliteInteger, sqliteTable } from 'drizzle-orm/sqlite-core'
import { type Field, setDrizzleColumnBuilder } from './fields/base'
import { setTableBuilder } from './models/base'
import type { ModelClass } from './models/types'
import type { Dialect } from './query/sql'

function applyModifiers(col: any, field: Field<any, any>): any {
  let c = col
  if (!field.null) c = c.notNull()
  if (field.primaryKey) c = c.primaryKey()
  else if (field.unique) c = c.unique()
  if (field.hasDefault()) c = c.$defaultFn(() => field.getDefault())
  return c
}

/**
 * Drizzle column for a field. Values go through the field's `toDb`/`fromDb`, so drizzle queries
 * return the same JS values as the ORM (Dates, booleans, decimal strings, parsed JSON).
 */
export function buildDrizzleColumn(field: Field<any, any>, dialect: Dialect): any {
  if (!field.concrete) return undefined
  if (dialect === 'sqlite') {
    if (field.isAutoField) return sqliteInteger(field.column).primaryKey({ autoIncrement: true })
    const ct = sqliteCustomType<{ data: any; driverData: any }>({
      dataType: () => field.dbType('sqlite') ?? 'text',
      toDriver: (v) => field.toDb(v, 'sqlite') as any,
      fromDriver: (v) => field.fromDb(v, 'sqlite'),
    })
    return applyModifiers(ct(field.column), field)
  }
  if (field.isAutoField) {
    const base =
      field.internalType === 'AutoField'
        ? pgInteger(field.column)
        : field.internalType === 'SmallAutoField'
          ? pgSmallint(field.column)
          : pgBigint(field.column, { mode: 'number' })
    return base.primaryKey().generatedByDefaultAsIdentity()
  }
  if (field.internalType === 'JSONField') return applyModifiers(jsonb(field.column), field)
  const ct = pgCustomType<{ data: any; driverData: any }>({
    dataType: () => field.dbType('postgresql') ?? 'text',
    toDriver: (v) => field.toDb(v, 'postgresql') as any,
    fromDriver: (v) => field.fromDb(v, 'postgresql'),
  })
  return applyModifiers(ct(field.column), field)
}

const cache = new WeakMap<ModelClass, Map<string, any>>()

/** The drizzle table for a model (`Post.table()` / `getTable(Post, 'postgresql')`). Cached per dialect. */
export function getTable(model: ModelClass, dialect: Dialect = 'sqlite'): any {
  const meta = model._meta
  const key = `${dialect}:${meta.dbTable}`
  let perModel = cache.get(model)
  if (!perModel) {
    perModel = new Map()
    cache.set(model, perModel)
  }
  let table = perModel.get(key)
  if (!table) {
    const columns: Record<string, any> = {}
    for (const f of meta.concreteFields) columns[f.attname] = buildDrizzleColumn(f, dialect)
    table = dialect === 'sqlite' ? sqliteTable(meta.dbTable, columns) : pgTable(meta.dbTable, columns)
    perModel.set(key, table)
  }
  return table
}

/** All tables of the given models (plus auto-created M2M tables), keyed by `label`. */
export function getSchema(models: ModelClass[], dialect: Dialect = 'sqlite'): Record<string, any> {
  const out: Record<string, any> = {}
  const add = (m: ModelClass) => {
    out[m._meta.objectName] = getTable(m, dialect)
  }
  for (const m of models) {
    add(m)
    for (const f of m._meta.localManyToMany) if (f.throughModel?._meta.autoCreated) add(f.throughModel)
  }
  return out
}

setDrizzleColumnBuilder(buildDrizzleColumn)
setTableBuilder(getTable)
