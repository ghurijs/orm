import {
  BigIntegerField,
  BinaryField,
  BooleanField,
  CASCADE,
  CharField,
  DateField,
  DateTimeField,
  DecimalField,
  DO_NOTHING,
  DurationField,
  EmailField,
  FloatField,
  ForeignKey,
  GenericIPAddressField,
  IntegerField,
  JSONField,
  Manager,
  ManyToManyField,
  MinValueValidator,
  Model,
  OneToOneField,
  PositiveIntegerField,
  PROTECT,
  RESTRICT,
  type RelatedManager,
  SET,
  SET_DEFAULT,
  SET_NULL,
  SlugField,
  TextField,
  TimeField,
  URLField,
  UUIDField,
  type Related,
} from '../src/index'

export class Author extends Model({
  name: new CharField({ maxLength: 100 }),
  email: new EmailField({ unique: true, null: true, blank: true }),
  age: new IntegerField({ null: true, blank: true }),
  isActive: new BooleanField({ default: true }),
  bio: new TextField({ blank: true }),
}) {
  declare static objects: Manager<Author>
  static Meta = { appLabel: 'tests', ordering: ['name'] }
  declare posts: RelatedManager<Post>
  declare comments: RelatedManager<Comment>
  declare profile: Related<Profile>
  toString(): string {
    return this.name
  }
}

export class Profile extends Model({
  author: new OneToOneField(() => Author, { onDelete: CASCADE, relatedName: 'profile' }),
  website: new URLField({ blank: true }),
  settings: new JSONField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Profile>
  static Meta = { appLabel: 'tests' }
}

export class Category extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
  parent: new ForeignKey('self', { onDelete: CASCADE, null: true, blank: true, relatedName: 'children' }),
}) {
  declare static objects: Manager<Category>
  static Meta = { appLabel: 'tests', verboseNamePlural: 'categories' }
  declare children: RelatedManager<Category>
}

export class Tag extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
}) {
  declare static objects: Manager<Tag>
  static Meta = { appLabel: 'tests', ordering: ['name'] }
  declare posts: import('../src/index').ManyRelatedManager<Post>
}

class PublishedManager extends Manager<Post> {
  override getQueryset() {
    return super.getQueryset().filter({ published: true })
  }
}

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  published: new BooleanField({ default: false }),
  views: new IntegerField({ default: 0, validators: [new MinValueValidator(0)] }),
  rating: new DecimalField({ maxDigits: 5, decimalPlaces: 2, null: true, blank: true }),
  author: new ForeignKey(() => Author, { onDelete: CASCADE, relatedName: 'posts' }),
  category: new ForeignKey(() => Category, { onDelete: SET_NULL, null: true, blank: true, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  publishDate: new DateField({ null: true, blank: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
  metadata: new JSONField({ default: () => ({}) }),
  status: new CharField({
    maxLength: 10,
    choices: [
      ['draft', 'Draft'],
      ['live', 'Live'],
    ],
    default: 'draft',
  }),
}) {
  static Meta = { appLabel: 'tests', ordering: ['-createdAt', '-id'], uniqueTogether: [['title', 'author']] }
  declare static objects: Manager<Post>
  static published = new PublishedManager()
  declare comments: RelatedManager<Comment>
  toString(): string {
    return this.title
  }
}

export class Comment extends Model({
  post: new ForeignKey(() => Post, { onDelete: CASCADE, relatedName: 'comments' }),
  author: new ForeignKey(() => Author, { onDelete: PROTECT, null: true, blank: true, relatedName: 'comments' }),
  text: new TextField(),
  score: new IntegerField({ default: 0 }),
  approved: new BooleanField({ default: false }),
}) {
  declare static objects: Manager<Comment>
  static Meta = { appLabel: 'tests', ordering: ['id'] }
}

/** Every scalar field type, for round-trips. */
export class Sample extends Model({
  char: new CharField({ maxLength: 20, blank: true }),
  text: new TextField({ blank: true }),
  int: new IntegerField({ null: true }),
  big: new BigIntegerField({ null: true }),
  positive: new PositiveIntegerField({ null: true }),
  float: new FloatField({ null: true }),
  dec: new DecimalField({ maxDigits: 10, decimalPlaces: 3, null: true }),
  flag: new BooleanField({ null: true }),
  day: new DateField({ null: true }),
  at: new DateTimeField({ null: true }),
  time: new TimeField({ null: true }),
  dur: new DurationField({ null: true }),
  data: new JSONField({ null: true }),
  blob: new BinaryField({ null: true }),
  uuid: new UUIDField({ null: true }),
  ip: new GenericIPAddressField({ null: true }),
}) {
  declare static objects: Manager<Sample>
  static Meta = { appLabel: 'tests' }
}

// ---- onDelete behaviours ------------------------------------------------------------------------

export class Owner extends Model({
  name: new CharField({ maxLength: 50 }),
}) {
  declare static objects: Manager<Owner>
  static Meta = { appLabel: 'tests' }
}

export const fallbackOwnerId = { value: null as number | null }

export class Pet extends Model({
  name: new CharField({ maxLength: 50 }),
  protectOwner: new ForeignKey(() => Owner, { onDelete: PROTECT, null: true, relatedName: 'protectedPets' }),
  restrictOwner: new ForeignKey(() => Owner, { onDelete: RESTRICT, null: true, relatedName: 'restrictedPets' }),
  nullOwner: new ForeignKey(() => Owner, { onDelete: SET_NULL, null: true, relatedName: 'nulledPets' }),
  defaultOwner: new ForeignKey(() => Owner, { onDelete: SET_DEFAULT, null: true, default: null, relatedName: 'defaultedPets' }),
  setOwner: new ForeignKey(() => Owner, { onDelete: SET(() => fallbackOwnerId.value), null: true, relatedName: 'setPets' }),
  loudOwner: new ForeignKey(() => Owner, { onDelete: DO_NOTHING, null: true, dbConstraint: false, relatedName: 'loudPets' }),
  cascadeOwner: new ForeignKey(() => Owner, { onDelete: CASCADE, null: true, relatedName: 'cascadePets' }),
}) {
  declare static objects: Manager<Pet>
  static Meta = { appLabel: 'tests' }
}

/** RESTRICT is allowed when the referencing row is deleted through another CASCADE path. */
export class Visit extends Model({
  owner: new ForeignKey(() => Owner, { onDelete: CASCADE, relatedName: 'visits' }),
  pet: new ForeignKey(() => Pet, { onDelete: CASCADE, null: true, relatedName: 'visits' }),
}) {
  declare static objects: Manager<Visit>
  static Meta = { appLabel: 'tests' }
}

export const allModels = [Author, Profile, Category, Tag, Post, Comment, Sample, Owner, Pet, Visit]
