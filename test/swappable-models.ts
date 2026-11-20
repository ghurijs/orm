// Fixture for the swappable-model tests: a reusable `pets` app whose `Owner` can be swapped with
// `PETS.OWNER_MODEL` (like `auth.User` / `AUTH_USER_MODEL`), and a project app `clinic` with a replacement.
import { AppConfig } from '@ghuri/core'
import {
  CASCADE,
  CharField,
  ForeignKey,
  getSwappableModel,
  type Manager,
  Model,
  SET_NULL,
} from '../src/index'
import { Migration, operations as ops, swappableDependency, swappableModel } from '../src/migrations'

export class Vet extends Model({ name: new CharField({ maxLength: 50 }) }) {
  declare static objects: Manager<Vet>
  static Meta = { appLabel: 'clinic' }
}

function ownerModel() {
  return getSwappableModel('PETS.OWNER_MODEL', 'pets.Owner')
}

/** The default owner model of `pets` (table `pets_owner`). */
export class Owner extends Model({
  name: new CharField({ maxLength: 50 }),
  email: new CharField({ maxLength: 100, default: '' }),
  vet: new ForeignKey(() => Vet, { onDelete: SET_NULL, null: true, relatedName: 'owners' }),
}) {
  declare static objects: Manager<Owner>
  static Meta = { appLabel: 'pets', swappable: 'PETS.OWNER_MODEL' }
}

export class Pet extends Model({
  name: new CharField({ maxLength: 50 }),
  owner: new ForeignKey(ownerModel, { onDelete: CASCADE, relatedName: 'pets' }),
}) {
  declare static objects: Manager<Pet>
  static Meta = { appLabel: 'pets' }
}

/** The project's replacement (`PETS.OWNER_MODEL: 'clinic.Client'`), reusing the reverse accessor names. */
export class Client extends Model({
  name: new CharField({ maxLength: 50 }),
  phone: new CharField({ maxLength: 20, default: '' }),
  vet: new ForeignKey(() => Vet, { onDelete: SET_NULL, null: true, relatedName: 'owners' }),
}) {
  declare static objects: Manager<Client>
  static Meta = { appLabel: 'clinic' }
}

const owner = swappableModel('PETS.OWNER_MODEL', 'pets.Owner')

/** `pets` migrations as a reusable app ships them: the owner is named through its setting. */
export const petsMigrations = {
  '0001_initial': new Migration({
    initial: true,
    dependencies: [['clinic', '0001_initial'], swappableDependency('PETS.OWNER_MODEL', 'pets.Owner')],
    operations: [
      ops.CreateModel({
        name: 'Owner',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 50 },
          vet: {
            type: 'ForeignKey',
            to: 'clinic.Vet',
            onDelete: 'SET_NULL',
            null: true,
            dbIndex: true,
            relatedName: 'owners',
          },
        },
        options: { swappable: 'PETS.OWNER_MODEL' },
      }),
      ops.CreateModel({
        name: 'Pet',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 50 },
          owner: { type: 'ForeignKey', to: owner, onDelete: 'CASCADE', dbIndex: true, relatedName: 'pets' },
        },
      }),
    ],
  }),
  '0002_owner_email': new Migration({
    dependencies: [['pets', '0001_initial']],
    operations: [
      ops.AddField({
        modelName: 'Owner',
        name: 'email',
        field: { type: 'CharField', maxLength: 100, default: '' },
      }),
      ops.AlterField({ modelName: 'Owner', name: 'name', field: { type: 'CharField', maxLength: 50 } }),
    ],
  }),
  '0003_pet_owner_nullable': new Migration({
    dependencies: [['pets', '0002_owner_email']],
    operations: [
      ops.AlterField({
        modelName: 'Pet',
        name: 'owner',
        field: { type: 'ForeignKey', to: owner, onDelete: 'CASCADE', dbIndex: true, relatedName: 'pets' },
      }),
    ],
  }),
}

export const clinicMigrations = {
  '0001_initial': new Migration({
    initial: true,
    operations: [
      ops.CreateModel({
        name: 'Vet',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 50 },
        },
      }),
    ],
  }),
  '0002_client': new Migration({
    dependencies: [['clinic', '0001_initial']],
    operations: [
      ops.CreateModel({
        name: 'Client',
        fields: {
          id: { type: 'BigAutoField', primaryKey: true },
          name: { type: 'CharField', maxLength: 50 },
          phone: { type: 'CharField', maxLength: 20, default: '' },
          vet: {
            type: 'ForeignKey',
            to: 'clinic.Vet',
            onDelete: 'SET_NULL',
            null: true,
            dbIndex: true,
            relatedName: 'owners',
          },
        },
      }),
    ],
  }),
}

/** `[ClinicConfig, PetsConfig]`; `withClient` installs the replacement model and its migration. */
export function installedApps(withClient: boolean) {
  class ClinicConfig extends AppConfig {
    name = 'clinic'
    override models = withClient ? { Vet, Client } : { Vet }
    override migrations = {
      migrations: withClient ? clinicMigrations : { '0001_initial': clinicMigrations['0001_initial'] },
    }
  }
  class PetsConfig extends AppConfig {
    name = 'pets'
    override models = { Owner, Pet }
    override migrations = { migrations: petsMigrations }
  }
  return [ClinicConfig, PetsConfig]
}
