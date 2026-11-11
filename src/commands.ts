// @ghuri/orm/commands — ORM management commands (Node only): makemigrations, migrate, showmigrations,
// sqlmigrate, dumpdata, loaddata, copydata, flush. Importing this module installs the Node hooks that read
// migration files from disk and write generated ones.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type ArgumentParser,
  apps,
  BaseCommand,
  type CommandClass,
  CommandError,
  type CommandIO,
  type CommandRegistry,
  commandRegistry,
} from '@ghuri/core'
import './models/relations'
import './drizzle'
import { copyData, dumpData, type FixtureObject, flushDatabase, loadData } from './data'
import { makeMigrations, migrate, showMigrations, sqlMigrate, sqlMigrateAll } from './migrations/api'
import { MigrationError } from './migrations/errors'
import { installNodeMigrationHooks } from './migrations/node'
import type { Dialect } from './query/sql'

installNodeMigrationHooks()

export {
  type CopyDataOptions,
  copyData,
  type DumpDataOptions,
  dumpData,
  type FixtureObject,
  type FlushOptions,
  flushDatabase,
  type LoadDataOptions,
  type LoadDataResult,
  loadData,
} from './data'
export {
  type GeneratedMigration,
  type MakeMigrationsOptions,
  type MakeMigrationsResult,
  type MigrateOptions,
  type MigrateResult,
  type MigrationStatus,
  makeMigrations,
  migrate,
  type ShowMigrationsOptions,
  type SqlMigrateAllOptions,
  type SqlMigrateOptions,
  type SqlMigrationFile,
  showMigrations,
  sqlMigrate,
  sqlMigrateAll,
} from './migrations/api'
export {
  installNodeMigrationHooks,
  loadMigrationsFromDisk,
  nodeMigrationFileSystem,
  setMigrationImporter,
} from './migrations/node'

// ---- argument helpers (accept camelCase, kebab-case and snake_case keys) ---------------------------

function pick(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    const variants = [n, n.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), n.replace(/-/g, '_')]
    for (const v of variants) if (args[v] !== undefined) return args[v]
  }
  return undefined
}

function flag(args: Record<string, unknown>, ...names: string[]): boolean {
  const v = pick(args, names)
  return v === true || v === 'true' || v === 1
}

function str(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const v = pick(args, names)
  if (v === undefined || v === null || v === false) return undefined
  return Array.isArray(v) ? String(v[0]) : String(v)
}

function list(args: Record<string, unknown>, ...names: string[]): string[] {
  const v = pick(args, names)
  if (v === undefined || v === null || v === false) return []
  return (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `--no-input` / `--noinput` / `input: false` / `interactive: false`. */
function noInput(args: Record<string, unknown>): boolean {
  return flag(args, 'no-input', 'noinput') || args.input === false || args.interactive === false
}

function database(args: Record<string, unknown>): string {
  return str(args, 'database') ?? 'default'
}

function databaseOption(parser: ArgumentParser): void {
  parser.option('--database <alias>', { help: 'Database alias to use (DATABASES key).', default: 'default' })
}

/** Run a handler, turning migration errors into CommandError (clean CLI messages). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof MigrationError) throw new CommandError(e.message)
    throw e
  }
}

function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      data += c
    })
    process.stdin.on('end', () => res(data))
    process.stdin.on('error', rej)
  })
}

// ---- commands -----------------------------------------------------------------------------------

/** `makemigrations [app...] [--name] [--empty] [--dry-run] [--check] [--merge] [--no-input]` */
export class MakemigrationsCommand extends BaseCommand {
  static override help = 'Creates new migration(s) for apps.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app', { variadic: true, help: 'App label(s) to create migrations for.' })
      .option('-n, --name <name>', { help: 'Use this name for the migration file(s).' })
      .option('--empty', { help: 'Create an empty migration.' })
      .option('--dry-run', { help: "Just show what migrations would be made; don't actually write them." })
      .option('--check', { help: 'Exit with a non-zero status if model changes are missing migrations.' })
      .option('--merge', { help: 'Enable fixing of migration conflicts.' })
      .option('--no-input', { help: 'Do not prompt the user for input of any kind.' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const res = await guard(() =>
      makeMigrations({
        appLabels: list(args, 'app', 'apps', 'app-labels', 'app-label'),
        name: str(args, 'name'),
        empty: flag(args, 'empty'),
        dryRun: flag(args, 'dry-run'),
        check: flag(args, 'check'),
        merge: flag(args, 'merge'),
        interactive: !noInput(args) && Boolean(io.prompt || io.confirm),
        io,
      }),
    )
    return res.exitCode
  }
}

/** `migrate [app] [target] [--fake] [--fake-initial] [--plan] [--run-syncdb] [--database]` */
export class MigrateCommand extends BaseCommand {
  static override help = 'Updates database schema. Manages both apps with migrations and those without.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app', { help: 'App label of an application to synchronize the state.' })
      .argument('target', { help: "Migration name to bring the database to; 'zero' unapplies all." })
      .option('--fake', { help: 'Mark migrations as run without actually running them.' })
      .option('--fake-initial', { help: 'Fake initial migrations whose tables already exist.' })
      .option('--plan', { help: 'Shows a list of the migration actions that will be performed.' })
      .option('--run-syncdb', { help: 'Creates tables for apps without migrations.' })
      .option('--no-input', { help: 'Do not prompt the user for input of any kind.' })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    await guard(() =>
      migrate({
        appLabel: str(args, 'app', 'app-label'),
        target: str(args, 'target', 'migration-name'),
        using: database(args),
        fake: flag(args, 'fake'),
        fakeInitial: flag(args, 'fake-initial'),
        plan: flag(args, 'plan'),
        runSyncdb: flag(args, 'run-syncdb'),
        io,
      }),
    )
    return 0
  }
}

/** `showmigrations [app...] [--plan] [--database]` */
export class ShowmigrationsCommand extends BaseCommand {
  static override help = 'Shows all available migrations for the current project.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app', { variadic: true, help: 'App labels of applications to limit the output to.' })
      .option('-p, --plan', { help: 'Shows all migrations in the order they will be applied.' })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    await guard(() =>
      showMigrations({
        appLabels: list(args, 'app', 'apps', 'app-label'),
        plan: flag(args, 'plan'),
        using: database(args),
        io,
      }),
    )
    return 0
  }
}

/**
 * `sqlmigrate app name [--backwards] [--dialect sqlite|postgresql] [--database]` and
 * `sqlmigrate --all [--out <dir>]` (numbered `.sql` files for `wrangler d1 migrations apply`).
 */
export class SqlmigrateCommand extends BaseCommand {
  static override help = 'Prints the SQL statements for the named migration.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app', { help: 'App label of the application containing the migration.' })
      .argument('name', { help: 'Migration name to print the SQL for.' })
      .option('--backwards', { help: 'Creates SQL to unapply the migration, rather than to apply it.' })
      .option('--dialect <dialect>', { help: "SQL dialect: 'sqlite' (SQLite / D1) or 'postgresql'." })
      .option('--all', { help: 'Every migration, as numbered SQL files (wrangler d1 migrations).' })
      .option('--out <dir>', { help: 'With --all: directory to write the .sql files to.' })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const dialect = str(args, 'dialect') as Dialect | undefined
    if (dialect && dialect !== 'sqlite' && dialect !== 'postgresql')
      throw new CommandError(`Unknown dialect '${dialect}' (use sqlite or postgresql).`)
    const using = database(args)
    if (flag(args, 'all')) {
      const outDir = str(args, 'out', 'output')
      const dir = outDir ? resolve(outDir) : undefined
      const existing = dir && existsSync(dir) ? await readdir(dir) : []
      const files = await guard(() => sqlMigrateAll({ dialect: dialect ?? 'sqlite', using, existing }))
      if (!dir) {
        for (const f of files) io.stdout(`-- ${f.filename}\n${f.sql}`)
        return 0
      }
      await mkdir(dir, { recursive: true })
      for (const f of files) {
        await writeFile(join(dir, f.filename), f.sql, 'utf8')
        io.stdout(io.style.success(`  ${join(outDir!, f.filename)}`))
      }
      if (!files.length) io.stdout('No new migrations to write.')
      return 0
    }
    const app = str(args, 'app', 'app-label')
    const name = str(args, 'name', 'migration-name')
    if (!app || !name)
      throw new CommandError('sqlmigrate needs an app label and a migration name (or --all).')
    const sql = await guard(() =>
      sqlMigrate(app, name, { dialect, backwards: flag(args, 'backwards'), using }),
    )
    io.stdout(sql.join('\n'))
    return 0
  }
}

/** `dumpdata [app[.Model]...] [--indent n] [--output file] [--exclude label] [--database]` */
export class DumpdataCommand extends BaseCommand {
  static override help = 'Output the contents of the database as a fixture of the given format (JSON).'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app_label', {
        variadic: true,
        help: 'Restricts dumped data to the specified app_label or app_label.ModelName.',
      })
      .option('--indent <n>', { help: 'Specifies the indent level to use when pretty-printing output.' })
      .option('-o, --output <file>', { help: 'Specifies file to which the output is written.' })
      .option('-e, --exclude <label>', {
        help: 'An app_label or app_label.ModelName to exclude (repeatable).',
      })
      .option('--format <format>', { help: "Serialization format (only 'json').", default: 'json' })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const format = str(args, 'format') ?? 'json'
    if (format !== 'json') throw new CommandError(`Unknown serialization format: ${format}`)
    const objects = await dumpData({
      labels: list(args, 'app_label', 'app-label', 'app', 'labels'),
      exclude: list(args, 'exclude'),
      using: database(args),
    })
    const indentRaw = str(args, 'indent')
    const indent = indentRaw !== undefined ? Number(indentRaw) : undefined
    const json = JSON.stringify(objects, null, indent)
    const output = str(args, 'output')
    if (output) {
      await writeFile(resolve(output), `${json}\n`, 'utf8')
      io.stderr(`Dumped ${objects.length} object(s) to ${output}`)
    } else io.stdout(json)
    return 0
  }
}

async function resolveFixture(name: string): Promise<string[]> {
  if (name === '-') return ['-']
  const candidates = [name, `${name}.json`]
  for (const c of candidates) if (existsSync(resolve(c))) return [resolve(c)]
  if (!isAbsolute(name)) {
    const found: string[] = []
    for (const config of apps.getAppConfigs()) {
      if (!config.path) continue
      for (const c of candidates) {
        const p = join(config.path, 'fixtures', c)
        if (existsSync(p)) found.push(p)
      }
    }
    if (found.length) return found
  }
  throw new CommandError(`No fixture named '${name}' found.`)
}

/** `loaddata fixture... [--database] [--exclude label]` */
export class LoaddataCommand extends BaseCommand {
  static override help = 'Installs the named fixture(s) in the database.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('fixture', {
        variadic: true,
        required: true,
        help: "Fixture file(s): paths, names in <app>/fixtures, or '-' for stdin.",
      })
      .option('-e, --exclude <label>', {
        help: 'An app_label or app_label.ModelName to exclude (repeatable).',
      })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const names = list(args, 'fixture', 'fixtures', 'file', 'files')
    if (!names.length)
      throw new CommandError(
        'No database fixture specified. Please provide the path of at least one fixture.',
      )
    const exclude = new Set(list(args, 'exclude').map((s) => s.toLowerCase()))
    let objects: FixtureObject[] = []
    let fixtures = 0
    for (const name of names) {
      for (const file of await resolveFixture(name)) {
        const text = file === '-' ? await readStdin() : await readFile(file, 'utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch (e) {
          throw new CommandError(`Problem installing fixture '${file}': ${(e as Error).message}`)
        }
        if (!Array.isArray(parsed)) throw new CommandError(`Fixture '${file}' must contain a JSON array.`)
        objects.push(...(parsed as FixtureObject[]))
        fixtures++
      }
    }
    if (exclude.size)
      objects = objects.filter(
        (o) => !exclude.has(o.model.toLowerCase()) && !exclude.has(o.model.split('.')[0].toLowerCase()),
      )
    const res = await loadData(objects, { using: database(args) })
    io.stdout(`Installed ${res.objects} object(s) from ${fixtures} fixture(s)`)
    return 0
  }
}

/** `copydata --from <alias> --to <alias> [app[.Model]...] [--exclude label] [--flush] [--no-input]` */
export class CopydataCommand extends BaseCommand {
  static override help =
    'Copies every row from one database alias to another (dumpdata + loaddata in-process).'

  override addArguments(parser: ArgumentParser): void {
    parser
      .argument('app_label', { variadic: true, help: 'Restrict to app_label or app_label.ModelName.' })
      .option('--from <alias>', { help: 'Source database alias.', default: 'default' })
      .option('--to <alias>', { help: 'Destination database alias (migrate it first).' })
      .option('-e, --exclude <label>', {
        help: 'An app_label or app_label.ModelName to exclude (repeatable).',
      })
      .option('--flush', { help: 'Delete every row of the destination first.' })
      .option('--no-input', { help: 'Do not prompt the user for input of any kind.' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const from = str(args, 'from') ?? 'default'
    const to = str(args, 'to')
    if (!to) throw new CommandError('copydata needs --to <alias>.')
    if (from === to) throw new CommandError('--from and --to must be different databases.')
    const flush = flag(args, 'flush')
    if (flush && !noInput(args)) {
      if (!io.confirm) throw new CommandError('Refusing to flush the destination without --no-input.')
      const ok = await io.confirm(
        `This will DELETE every row in the "${to}" database before copying. Continue?`,
        {
          default: false,
        },
      )
      if (!ok) {
        io.stdout('Copy cancelled.')
        return 1
      }
    }
    const res = await copyData({
      from,
      to,
      labels: list(args, 'app_label', 'app-label', 'app', 'labels'),
      exclude: list(args, 'exclude'),
      flush,
    })
    io.stdout(
      io.style.success(
        `Copied ${res.objects} object(s) of ${res.models} model(s) from '${from}' to '${to}'.`,
      ),
    )
    return 0
  }
}

/** `flush [--no-input] [--database]` */
export class FlushCommand extends BaseCommand {
  static override help =
    'Removes ALL DATA from the database, including data added during migrations. Does not achieve a "fresh install" state.'

  override addArguments(parser: ArgumentParser): void {
    parser.option('--no-input', { help: 'Do not prompt the user for input of any kind.' })
    databaseOption(parser)
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const using = database(args)
    if (!noInput(args)) {
      if (!io.confirm)
        throw new CommandError('flush needs confirmation; pass --no-input to run non-interactively.')
      const ok = await io.confirm(
        `You have requested a flush of the database. This will IRREVERSIBLY DESTROY all data currently in the "${using}" database, ` +
          'and return each table to an empty state. Are you sure you want to do this?',
        { default: false },
      )
      if (!ok) {
        io.stdout('Flush cancelled.')
        return 1
      }
    }
    const tables = await flushDatabase({ using })
    io.stdout(io.style.success(`Flushed ${tables.length} table(s) in '${using}'.`))
    return 0
  }
}

/** Every ORM command by name. */
export const ormCommands: Record<string, CommandClass> = {
  makemigrations: MakemigrationsCommand,
  migrate: MigrateCommand,
  showmigrations: ShowmigrationsCommand,
  sqlmigrate: SqlmigrateCommand,
  dumpdata: DumpdataCommand,
  loaddata: LoaddataCommand,
  copydata: CopydataCommand,
  flush: FlushCommand,
}

/** Register the ORM commands in core's `commandRegistry` (or another registry). */
export function registerOrmCommands(registry: CommandRegistry = commandRegistry): void {
  for (const [name, cls] of Object.entries(ormCommands)) registry.register(name, cls)
}
