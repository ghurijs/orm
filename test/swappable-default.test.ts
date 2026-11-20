// Swappable models that are not swapped behave like any model; makemigrations writes relations to them through
// their setting (Django's `to=settings.AUTH_USER_MODEL` + `swappable_dependency`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfig, apps, bufferIO, createContext, setGlobalContext } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerOrmCommands } from '../src/commands'
import { CASCADE, ForeignKey, getSwappableModel, type Manager, Model } from '../src/index'
import { MigrationLoader, makeMigrations, migrate } from '../src/migrations'
import { setupTestDatabase, testBackends } from '../src/testing'
import { installedApps, Owner, Pet, Vet } from './swappable-models'

registerOrmCommands()
const settings: Record<string, any> = { SECRET_KEY: 'test', DEBUG: true, INSTALLED_APPS: [] }
setGlobalContext(createContext({ env: {}, settings: settings as any }))

const root = mkdtempSync(join(tmpdir(), 'ghuri-swappable-'))
const visitsPath = join(root, 'visits')
mkdirSync(join(visitsPath, 'migrations'), { recursive: true })
writeFileSync(join(visitsPath, 'migrations', 'index.ts'), 'export const migrations = {}\n')

class Visit extends Model({
  owner: new ForeignKey(() => getSwappableModel('PETS.OWNER_MODEL'), { onDelete: CASCADE }),
  pet: new ForeignKey(() => Pet, { onDelete: CASCADE }),
}) {
  declare static objects: Manager<Visit>
}
class VisitsConfig extends AppConfig {
  name = 'visits'
  override path = visitsPath
  override models = { Visit }
}

beforeAll(async () => {
  await apps.populate([...installedApps(false), VisitsConfig])
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  apps.reset()
  setGlobalContext(undefined)
})

describe('a swappable model that is not swapped', () => {
  it('is installed and usable', () => {
    expect(Owner._meta.swapped).toBeUndefined()
    expect(apps.getModels()).toContain(Owner)
    expect(getSwappableModel('PETS.OWNER_MODEL')).toBe(Owner)
    expect(Vet._meta.relatedObjects.map((r) => r.relatedModel)).toEqual([Owner])
  })

  it('keeps every operation of its migrations, and the reusable app sees no changes', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    expect(loader.getMigration('pets', '0001_initial').operations).toHaveLength(2)
    expect([...(loader.graph.parents.get('pets.0001_initial') ?? [])]).toEqual(['clinic.0001_initial'])
    expect(loader.projectState().models.get('pets.pet')!.fields.get('owner')!.options.to).toBe('pets.Owner')
    // only `visits` (no migrations yet) has changes
    const res = await makeMigrations({ io: bufferIO(), check: true })
    expect(res.migrations.map((m) => m.app)).toEqual(['visits'])
  })

  it('makemigrations writes relations to it through its setting', async () => {
    const res = await makeMigrations({ io: bufferIO(), appLabels: ['visits'] })
    expect(res.migrations.map((m) => `${m.app}.${m.name}`)).toEqual(['visits.0001_initial'])
    const src = res.migrations[0].source
    expect(src).toContain(
      "import { Migration, operations as ops, swappableDependency, swappableModel } from '@ghuri/orm/migrations'",
    )
    expect(src).toContain(
      "  dependencies: [\n    ['pets', '0003_pet_owner_nullable'],\n    swappableDependency('PETS.OWNER_MODEL', 'pets.Owner'),\n  ],",
    )
    expect(src).toContain("to: swappableModel('PETS.OWNER_MODEL', 'pets.Owner')")
    expect(src).toContain("to: 'pets.Pet'")
    expect((await makeMigrations({ io: bufferIO(), check: true })).exitCode).toBe(0)
  })

  it('the CreateModel of a swappable model records the setting', async () => {
    const { ProjectState, MigrationAutodetector } = await import('../src/migrations')
    const changes = await new MigrationAutodetector(
      new ProjectState(),
      ProjectState.fromModels([Owner]),
    ).changes((await MigrationLoader.load({ connection: null })).graph)
    const create = changes.get('pets')![0].operations[0] as any
    expect(create.options.swappable).toBe('PETS.OWNER_MODEL')
  })
})

describe.each(testBackends())('migrate with the default model (%s)', (backend) => {
  it('creates its table', async () => {
    const db = await setupTestDatabase({ using: backend, models: [], createTables: false })
    try {
      await migrate({ io: bufferIO() })
      const vet = await Vet.objects.create({ name: 'Dr. No' })
      const bob = await Owner.objects.create({ name: 'Bob', vet })
      const rex = await Pet.objects.create({ name: 'Rex', owner: bob })
      await Visit.objects.create({ owner: bob, pet: rex })
      expect(await (bob as any).pets.count()).toBe(1)
      await vet.delete()
      await bob.delete()
      expect(await Visit.objects.count()).toBe(0)
    } finally {
      await db.teardown()
    }
  })
})
