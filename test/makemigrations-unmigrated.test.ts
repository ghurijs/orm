// Regression: `makemigrations <app>` for an app without a migrations directory (what a user has right
// after `ghuri startapp` if the directory was removed, or for hand-written apps) writes its initial migration.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfig, apps, bufferIO } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerOrmCommands } from '../src/commands'
import { CASCADE, CharField, ForeignKey, Model } from '../src/index'
import { MigrationLoader, makeMigrations, ProjectState } from '../src/migrations'

const root = mkdtempSync(join(tmpdir(), 'ghuri-mm-unmigrated-'))
const shopPath = join(root, 'shop')
registerOrmCommands()

class Category extends Model({ name: new CharField({ maxLength: 50 }) }) {
  static Meta = { appLabel: 'shop' }
}
class Product extends Model({
  name: new CharField({ maxLength: 100 }),
  category: new ForeignKey(() => Category, { onDelete: CASCADE }),
}) {
  static Meta = { appLabel: 'shop' }
}

class ShopConfig extends AppConfig {
  name = 'shop'
  override path = shopPath
  override models = { Category, Product }
}

beforeAll(async () => {
  await apps.populate([ShopConfig])
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  apps.reset()
})

describe('makemigrations for an app without migrations', () => {
  it('is an unmigrated app and plain `makemigrations` leaves it alone (like Django)', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    expect([...loader.unmigratedApps]).toEqual(['shop'])
    const res = await makeMigrations({ io: bufferIO(), check: true })
    expect(res.migrations).toEqual([])
  })

  it('`makemigrations shop` creates the directory and 0001_initial with every model', async () => {
    const io = bufferIO()
    const res = await makeMigrations({ appLabels: ['shop'], io })
    expect(res.migrations.map((g) => `${g.app}.${g.name}`)).toEqual(['shop.0001_initial'])
    const ops = res.migrations[0].migration.operations.map((o) => o.describe())
    expect(ops).toEqual(['Create model Category', 'Create model Product'])
    expect(existsSync(join(shopPath, 'migrations', '0001_initial.ts'))).toBe(true)
    expect(readFileSync(join(shopPath, 'migrations', 'index.ts'), 'utf8')).toContain('0001_initial')
    expect(io.out.join('\n')).toContain("Migrations for 'shop':")
  })

  it('then sees no further changes', async () => {
    const res = await makeMigrations({ appLabels: ['shop'], io: bufferIO(), check: true })
    expect(res.exitCode).toBe(0)
    expect(res.migrations).toEqual([])
  })
})

describe('historical state with unmigrated apps', () => {
  class Review extends Model({
    product: new ForeignKey('catalog.Item', { onDelete: CASCADE }),
  }) {
    static Meta = { appLabel: 'reviews' }
  }

  it("ignores an unmigrated app's relation to a model no migration has created yet", () => {
    // e.g. a test app's ForeignKey to auth.User while auth's 0001_initial is being applied
    const state = ProjectState.fromModels([Review])
    state.realApps.add('reviews')
    expect(state.apps.getModel('reviews.Review')).toBeTruthy()
  })

  it('still reports unresolved relations of migrated apps', () => {
    const state = ProjectState.fromModels([Review])
    expect(() => state.apps).toThrow(/can't be resolved in the migration state/)
  })
})
