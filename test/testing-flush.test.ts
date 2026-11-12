// Regression: the test database's flush() sends postMigrate (like `flush`), so post-migrate handlers such
// as @ghuri/auth's createPermissions repopulate their rows; setupTestDatabase sends it for unmigrated apps.
import { AppConfig, apps } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharField, Model, postMigrate } from '../src/index'
import { setupTestDatabase, type TestDatabase, testBackends } from '../src/testing'

class Flavor extends Model({ name: new CharField({ maxLength: 50 }) }) {
  static Meta = { appLabel: 'flavors' }
}

class FlavorsConfig extends AppConfig {
  name = 'flavors'
  override models = { Flavor }
}

const calls: Array<{ app: string; using: string }> = []
async function onPostMigrate(args: { appConfig: AppConfig; using: string }) {
  calls.push({ app: args.appConfig.appLabel, using: args.using })
  // what a post-migrate handler does: (re)create rows it owns
  if (!(await Flavor.objects.using(args.using).filter({ name: 'vanilla' }).exists()))
    await Flavor.objects.using(args.using).create({ name: 'vanilla' })
}

beforeAll(async () => {
  await apps.populate([FlavorsConfig])
  postMigrate.connect(onPostMigrate as never, { uid: 'test.flavors' })
})
afterAll(() => {
  postMigrate.disconnect('test.flavors')
  apps.reset()
})

describe.each(testBackends().filter((b) => b !== 'd1'))('test database postMigrate (%s)', (using) => {
  let db: TestDatabase
  beforeAll(async () => {
    calls.length = 0
    db = await setupTestDatabase({ using, models: [Flavor] })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })

  it('setupTestDatabase sends postMigrate for installed apps without migrations', async () => {
    expect(calls).toEqual([{ app: 'flavors', using: 'default' }])
    expect(await Flavor.objects.count()).toBe(1)
  })

  it('flush() deletes every row, then sends postMigrate', async () => {
    await Flavor.objects.create({ name: 'chocolate' })
    calls.length = 0
    await db.flush()
    expect(calls).toEqual([{ app: 'flavors', using: 'default' }])
    expect(await Flavor.objects.valuesList('name', { flat: true })).toEqual(['vanilla'])
  })

  it('flush({ inhibitPostMigrate: true }) leaves the tables empty', async () => {
    calls.length = 0
    await db.flush({ inhibitPostMigrate: true })
    expect(calls).toEqual([])
    expect(await Flavor.objects.count()).toBe(0)
  })
})
