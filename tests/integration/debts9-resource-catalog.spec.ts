import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/33 D-060 (докс/28 Spec 10 відк. (1)): ресурси бази знань у `/me/catalog` — `is_catalog_visible`/
 * `assign_mode` на ресурсі, збирач `catalogResources` поверх `canAccessResource` (докс/21 §14.1),
 * а не окремого тумблера каталогу (той — лише для курсів, докс/10 §14.1).
 */
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createTenant, ensureFirstAdmin, platformLogin, validatePlatformSession } = await import('../../server/services/platform')
const { purgeTenantData } = await import('../../server/services/platformTenants')
const { createResource, publishResource, updateResource, updateKnowledgeSettings, createAccessGroup, catalogResources } = await import('../../server/services/resources')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

const OPS_EMAIL = 'ops-d060@lola.local'
const OPS_PASSWORD = 'test-password-123'
const stamp = Date.now().toString(36)

let tenantId: string
let adminId: string
let employeeId: string
let opsAuth: { adminId: string, email: string, fullName: string }
const ctx = (actorId = adminId) => ({ tenantId, actorId })
const text = (html: string) => [{ id: 'b', type: 'text' as const, html }]

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await ensureFirstAdmin()
  opsAuth = (await validatePlatformSession((await platformLogin(OPS_EMAIL, OPS_PASSWORD))!.token))!
  const r = await createTenant({ slug: `d60-${stamp}`, name: 'Д060 Тест', adminPhone: '+380501234600', adminName: 'Автор Ресурсу', plan: 'trial' }, opsAuth)
  if (!r.ok) throw new Error('не удалось создать тестовый тенант')
  tenantId = r.tenantId
  adminId = r.adminUserId
  await admin`update users set status = 'active' where id = ${adminId}`
  const [emp] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, '+380501234601', 'Співробітник', 'active', current_date) returning id`
  employeeId = emp!.id as string
}, 30_000)

afterAll(async () => {
  if (tenantId) await purgeTenantData(tenantId, opsAuth).catch(() => {})
  await admin.end()
})

describe('docs/33 D-060 — ресурси в /me/catalog', () => {
  it('чернетка і ресурс без is_catalog_visible у каталог не потрапляють; публікація + прапорець — потрапляє', async () => {
    const r = await createResource(ctx(), { title: `Ресурс ${stamp}`, kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст</p>'), isCatalogVisible: true })
    expect(await catalogResources(ctx())).toEqual([]) // ще чернетка
    await publishResource(ctx(), r.id, { notifyAssigned: false })
    const cards = await catalogResources(ctx())
    expect(cards.find(c => c.id === r.id)).toMatchObject({ id: r.id, title: `Ресурс ${stamp}`, assignMode: 'catalog_free' })

    const r2 = await createResource(ctx(), { title: `Прихований ${stamp}`, kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст</p>') })
    await publishResource(ctx(), r2.id, { notifyAssigned: false })
    expect((await catalogResources(ctx())).find(c => c.id === r2.id)).toBeUndefined() // isCatalogVisible за замовчуванням false
  })

  it('assign_mode передається як є (catalog_free|catalog_request), доступ картки — як прямий перегляд ресурсу', async () => {
    const r = await createResource(ctx(), { title: `Заявка ${stamp}`, kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст</p>'), isCatalogVisible: true, assignMode: 'catalog_request' })
    await publishResource(ctx(), r.id, { notifyAssigned: false })
    expect((await catalogResources(ctx())).find(c => c.id === r.id)).toMatchObject({ assignMode: 'catalog_request' })

    // тумблер бази знань + групи доступу (докс/21 §14.1) — не бачить той, хто поза групою; автор бачить завжди
    await updateKnowledgeSettings(ctx(), { restrictAccess: true })
    const grp = await createAccessGroup(ctx(), { name: `Група ${stamp}`, appliesTo: 'knowledge', members: [{ subjectType: 'user', subjectId: employeeId }] })
    const r3 = await createResource(ctx(), { title: `Закритий ${stamp}`, kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: text('<p>Текст</p>'), isCatalogVisible: true, accessGroupIds: [] })
    await updateResource(ctx(), r3.id, { accessGroupIds: [] }) // без учасників групи ще нічого не приховує
    await publishResource(ctx(), r3.id, { notifyAssigned: false })
    // прив'язуємо групу вже після публікації робочої редакції (accessGroups — не версіоновані)
    const other = await createAccessGroup(ctx(), { name: `Інша ${stamp}`, appliesTo: 'knowledge', members: [] })
    await updateResource(ctx(), r3.id, { accessGroupIds: [other.id] })
    expect((await catalogResources(ctx(employeeId))).find(c => c.id === r3.id)).toBeUndefined() // співробітник не в «Інша»
    expect((await catalogResources(ctx(adminId))).find(c => c.id === r3.id)).toBeTruthy() // автор бачить завжди
    await updateResource(ctx(), r3.id, { accessGroupIds: [grp.id] })
    expect((await catalogResources(ctx(employeeId))).find(c => c.id === r3.id)).toBeTruthy() // тепер у «своїй» групі

    await updateKnowledgeSettings(ctx(), { restrictAccess: false })
  })
})
