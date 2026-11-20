// Swappable models (Django's Meta.swappable): PETS.OWNER_MODEL names `clinic.Client` instead of `pets.Owner`.
import { AppConfig, apps, bufferIO, createContext, ImproperlyConfigured, setGlobalContext } from '@ghuri/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSwappableModel } from '../src/index'
import {
  Migration,
  MigrationLoader,
  MigrationWriter,
  makeMigrations,
  migrate,
  operations as ops,
  swappableDependency,
  swappableModel,
} from '../src/migrations'
import { setupTestDatabase, testBackends } from '../src/testing'
import { Client, clinicMigrations, installedApps, Owner, Pet, Vet } from './swappable-models'

const settings: Record<string, any> = {
  SECRET_KEY: 'test',
  DEBUG: true,
  INSTALLED_APPS: [],
  PETS: { OWNER_MODEL: 'clinic.Client' },
}
setGlobalContext(createContext({ env: {}, settings: settings as any }))
const installed = installedApps(true)

beforeAll(async () => {
  await apps.populate(installed)
})
afterAll(() => {
  apps.reset()
  setGlobalContext(undefined)
})

describe('a swapped model', () => {
  it('reports what replaced it (dotted setting path) and is not installed', () => {
    expect(Owner._meta.swappable).toBe('PETS.OWNER_MODEL')
    expect(Owner._meta.swapped).toBe('clinic.Client')
    expect(Client._meta.swapped).toBeUndefined()
    expect(apps.getModels()).not.toContain(Owner)
    expect(apps.getModels()).toContain(Client)
    expect(() => apps.getModel('pets.Owner')).toThrow()
    expect(getSwappableModel('PETS.OWNER_MODEL')).toBe(Client)
  })

  it('has no usable manager (Django\'s "Manager isn\'t available")', () => {
    expect(() => Owner.objects.all()).toThrow(
      "Manager isn't available; 'pets.Owner' has been swapped for 'clinic.Client' (PETS.OWNER_MODEL).",
    )
  })

  it('relations point at the replacement; its own relations are not reverse relations', () => {
    expect(Pet._meta.getForwardField('owner')!.relatedModel).toBe(Client)
    expect(Client._meta.relatedObjects.map((r) => r.name)).toEqual(['pets'])
    expect(Vet._meta.relatedObjects.map((r) => `${r.relatedModel._meta.label}.${r.field.name}`)).toEqual([
      'clinic.Client.vet',
    ])
    expect(Vet._meta.getRelatedObjectByAccessor('owners')!.relatedModel).toBe(Client)
  })

  it('getSwappableModel explains bad settings', () => {
    settings.OTHER_MODEL = 'nope'
    expect(() => getSwappableModel('OTHER_MODEL')).toThrow(
      "OTHER_MODEL must be of the form 'app_label.model_name'.",
    )
    settings.OTHER_MODEL = 'clinic.Missing'
    expect(() => getSwappableModel('OTHER_MODEL')).toThrow(
      "OTHER_MODEL refers to model 'clinic.Missing' that has not been installed.",
    )
    delete settings.OTHER_MODEL
    expect(() => getSwappableModel('OTHER_MODEL')).toThrow(ImproperlyConfigured)
  })
})

describe('migrations of a swapped model', () => {
  it('drop its operations, retarget relations and depend on the migration creating the replacement', async () => {
    const loader = await MigrationLoader.load({ connection: null })
    const pets1 = loader.getMigration('pets', '0001_initial')
    expect(pets1.operations.map((o) => o.describe())).toEqual(['Create model Pet'])
    expect((pets1.operations[0] as any).fields.owner.options.to).toBe('clinic.Client')
    expect(loader.getMigration('pets', '0002_owner_email').operations).toEqual([])
    expect([...(loader.graph.parents.get('pets.0001_initial') ?? [])].sort()).toEqual([
      'clinic.0001_initial',
      'clinic.0002_client',
    ])
    const state = loader.projectState()
    expect(state.models.has('pets.owner')).toBe(false)
    expect(state.models.get('pets.pet')!.fields.get('owner')!.options.to).toBe('clinic.Client')
  })

  it("fall back to the app's first migration when the creating one depends on them (no cycle)", async () => {
    const clinic = new (class extends AppConfig {
      name = 'clinic'
      override migrations = {
        migrations: {
          '0001_initial': clinicMigrations['0001_initial'],
          '0002_client': new Migration({
            dependencies: [
              ['clinic', '0001_initial'],
              ['pets', '0001_initial'],
            ],
            operations: clinicMigrations['0002_client'].operations,
          }),
        },
      }
    })()
    const pets = apps.getAppConfig('pets')
    const loader = await MigrationLoader.load({ connection: null, appConfigs: [clinic, pets] })
    expect([...(loader.graph.parents.get('pets.0001_initial') ?? [])]).toEqual(['clinic.0001_initial'])
    expect(loader.graph.fullPlan().map((k) => k.join('.'))).toContain('clinic.0002_client')
  })

  it('makemigrations --check is clean', async () => {
    const res = await makeMigrations({ io: bufferIO(), check: true })
    expect(res.migrations.map((m) => m.source)).toEqual([])
    expect(res.exitCode).toBe(0)
  })

  it('a swappableDependency on the own app is ignored', async () => {
    const own = new Migration({ dependencies: [swappableDependency('PETS.OWNER_MODEL', 'pets.Owner')] })
    expect([...own.dependencies[0]]).toEqual(['clinic', '__first__'])
    settings.PETS = {}
    try {
      expect([...own.dependencies[0]]).toEqual(['pets', '__first__'])
    } finally {
      settings.PETS = { OWNER_MODEL: 'clinic.Client' }
    }
  })

  it('the writer emits the markers', () => {
    const m = new Migration({
      dependencies: [['clinic', '0002_client'], swappableDependency('PETS.OWNER_MODEL', 'pets.Owner')],
      operations: [
        ops.AddField({
          modelName: 'Visit',
          name: 'owner',
          field: {
            type: 'ForeignKey',
            to: swappableModel('PETS.OWNER_MODEL', 'pets.Owner'),
            onDelete: 'CASCADE',
          },
        }),
      ],
    })
    m.name = '0002_visit_owner'
    const src = new MigrationWriter(m, { header: null }).asString()
    expect(src).toContain(
      "import { Migration, operations as ops, swappableDependency, swappableModel } from '@ghuri/orm/migrations'",
    )
    expect(src).toContain(
      "dependencies: [['clinic', '0002_client'], swappableDependency('PETS.OWNER_MODEL', 'pets.Owner')],",
    )
    expect(src).toContain("to: swappableModel('PETS.OWNER_MODEL', 'pets.Owner')")
    // operations read the label it names now
    expect((m.operations[0] as any).field.options.to).toBe('clinic.Client')
  })
})

describe.each(testBackends())('migrate with a swapped model (%s)', (backend) => {
  it('creates no table for it, and the replacement works with the reusable app', async () => {
    const db = await setupTestDatabase({ using: backend, models: [], createTables: false })
    try {
      const io = bufferIO()
      await migrate({ io })
      const out = io.out.join('\n')
      expect(out.indexOf('clinic.0002_client')).toBeLessThan(out.indexOf('pets.0001_initial'))
      const tables =
        db.connection.dialect === 'postgresql'
          ? (
              await db.connection.execute(
                "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
              )
            ).rows
          : (await db.connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows
      const names = tables.map((r: any) => r.name)
      expect(names).toContain('clinic_client')
      expect(names).toContain('pets_pet')
      expect(names).not.toContain('pets_owner')

      const vet = await Vet.objects.create({ name: 'Dr. Who' })
      const ann = await Client.objects.create({ name: 'Ann', vet })
      await Pet.objects.create({ name: 'Rex', owner: ann })
      expect((await Pet.objects.filter({ owner__name: 'Ann' })).map((p) => p.name)).toEqual(['Rex'])
      expect(await (ann as any).pets.count()).toBe(1)
      expect(await (vet as any).owners.count()).toBe(1)
      // deleting the vet must not touch the swapped model's (missing) table
      await vet.delete()
      expect((await Client.objects.get({ name: 'Ann' })).vetId).toBeNull()
      await ann.delete()
      expect(await Pet.objects.count()).toBe(0)
    } finally {
      await db.teardown()
    }
  })
})
