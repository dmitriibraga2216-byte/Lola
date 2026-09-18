import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from './schema'
import { SYSTEM_ROLES } from '../../shared/domain/roles'

/**
 * Сид этапа 0 (docs/07-stages.md): тенант «Каппі», две точки, позиции,
 * системные роли, тестовые люди. Идемпотентен: повторный запуск ничего не дублирует.
 * Идёт от владельца БД — сид создаёт данные до того, как появился контекст тенанта.
 */

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error('DATABASE_ADMIN_URL не задан')
  process.exit(1)
}

const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client, { schema })

const existing = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'kappi') })
if (existing) {
  console.log('Сид уже применён (тенант kappi существует) — пропускаю')
  await client.end()
  process.exit(0)
}

await db.transaction(async (tx) => {
  const [tenant] = await tx.insert(schema.tenants).values({
    slug: 'kappi',
    name: 'Каппі',
    locale: 'uk',
    timezone: 'Europe/Kyiv',
  }).returning()
  const tenantId = tenant!.id

  const [root] = await tx.insert(schema.orgUnits).values({
    tenantId,
    name: 'Каппі',
    path: 'kappi',
  }).returning()

  const [lazareva, segedska] = await tx.insert(schema.locations).values([
    { tenantId, orgUnitId: root!.id, name: 'Лазарева', address: 'Одеса, вул. Адміральська' },
    { tenantId, orgUnitId: root!.id, name: 'Сегедська', address: 'Одеса, вул. Сегедська' },
  ]).returning()

  const positions = await tx.insert(schema.positions).values([
    { tenantId, name: 'Кухар гарячого цеху', code: 'cook-hot' },
    { tenantId, name: 'Кухар холодного цеху', code: 'cook-cold' },
    { tenantId, name: 'Касир', code: 'cashier' },
    { tenantId, name: 'Курʼєр', code: 'courier' },
    { tenantId, name: 'Керуючий', code: 'manager' },
  ]).returning()
  const pos = Object.fromEntries(positions.map(p => [p.code, p]))

  const roles = await tx.insert(schema.roles).values(
    Object.entries(SYSTEM_ROLES).map(([code, r]) => ({
      tenantId, code, name: r.name, scopes: [...r.scopes], isSystem: true,
    })),
  ).returning()
  const role = Object.fromEntries(roles.map(r => [r.code, r]))

  const people = await tx.insert(schema.users).values([
    { tenantId, phone: '+380661864742', fullName: 'Адмін Каппі', status: 'active' },
    { tenantId, phone: '+380670000001', fullName: 'Монастирна Катерина', status: 'active' },
    { tenantId, phone: '+380670000002', fullName: 'Шеф Лазарева', status: 'active' },
    { tenantId, phone: '+380670000003', fullName: 'Кухар Тестовий', status: 'active' },
    { tenantId, phone: '+380670000004', fullName: 'Касир Тестова', status: 'invited' },
  ]).returning()
  const [adminU, hr, chef, cook, cashier] = people

  await tx.insert(schema.userPlacements).values([
    { tenantId, userId: chef!.id, locationId: lazareva!.id, positionId: pos['cook-hot']!.id },
    { tenantId, userId: cook!.id, locationId: lazareva!.id, positionId: pos['cook-hot']!.id },
    { tenantId, userId: cashier!.id, locationId: segedska!.id, positionId: pos['cashier']!.id },
    { tenantId, userId: hr!.id, locationId: lazareva!.id, positionId: pos['manager']!.id },
    { tenantId, userId: adminU!.id, locationId: lazareva!.id, positionId: pos['manager']!.id },
  ])

  await tx.insert(schema.userRoles).values([
    { tenantId, userId: adminU!.id, roleId: role['admin']!.id, scopeType: 'tenant' },
    { tenantId, userId: hr!.id, roleId: role['author']!.id, scopeType: 'tenant' },
    { tenantId, userId: chef!.id, roleId: role['mentor']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: chef!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: cook!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: cashier!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: segedska!.id },
  ])
})

console.log('Сид применён: тенант «Каппі», 2 точки, 5 позиций, 5 системных ролей, 5 людей')
await client.end()
