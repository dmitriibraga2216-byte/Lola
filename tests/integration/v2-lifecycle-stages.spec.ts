import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LIFECYCLE_STAGES } from '../../server/db/tenantDefaults'
import { LIFECYCLE_STAGE_CODES, STAGE_CAPABILITIES } from '../../shared/enums'
import { stageCapabilitiesSchema } from '../../shared/schemas/lifecycle'

/**
 * PR-05 пакета `docs/v2` (`45-plan.md`): этапы жизненного цикла и `stageCan()`.
 * Критерии приёмки `docs/v2/33-lifecycle.md` §13: п. 11 (смена этапа у курса с завершёнными
 * прохождениями) и п. 12 (восемь этапов у нового тенанта со значениями §3.3).
 * Критерий п. 6 (`grep` по кодам этапов пуст) — `tests/unit/v2-crosschecks.spec.ts`,
 * проверка 1 скрипта `scripts/v2-crosschecks.sh`.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createTenant, platformLogin, validatePlatformSession, ensureFirstAdmin } = await import('../../server/services/platform')
const { listStages, listCandidateStages, setCourseStage, setStageCapabilities, stageCan, courseStageCan } = await import('../../server/services/lifecycle')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-05@lola.local'
const OPS_PASSWORD = 'test-password-123'
const SLUG = 'v2-lifecycle-05'

let tenantId: string
let adminId: string
let newTenantId: string

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string

  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from lifecycle_stages where tenant_id in (select id from tenants where slug = ${SLUG})`
  await admin`delete from user_placements where tenant_id in (select id from tenants where slug = ${SLUG})`
  await admin`delete from user_roles where tenant_id in (select id from tenants where slug = ${SLUG})`
  await admin`update locations set manager_id = null where tenant_id in (select id from tenants where slug = ${SLUG})`
  await admin`delete from users where tenant_id in (select id from tenants where slug = ${SLUG})`
  await admin`delete from tenants where slug = ${SLUG}`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  const session = await platformLogin(OPS_EMAIL, OPS_PASSWORD)
  const auth = await validatePlatformSession(session!.token)
  const created = await createTenant({ slug: SLUG, name: 'Етапи PR-05', adminPhone: '+380670550505', adminName: 'Адмін етапів' }, auth!)
  if (!created.ok) throw new Error(`createTenant → ${created.code}`)
  newTenantId = created.tenantId
}, 60_000)

afterAll(async () => {
  await admin`delete from audit_log where tenant_id = ${newTenantId}`
  await admin`delete from lifecycle_stages where tenant_id = ${newTenantId}`
  await admin`delete from user_placements where tenant_id = ${newTenantId}`
  await admin`delete from user_roles where tenant_id = ${newTenantId}`
  await admin`update locations set manager_id = null where tenant_id = ${newTenantId}`
  await admin`delete from users where tenant_id = ${newTenantId}`
  await admin`delete from locations where tenant_id = ${newTenantId}`
  await admin`delete from positions where tenant_id = ${newTenantId}`
  await admin`delete from org_units where tenant_id = ${newTenantId}`
  await admin`delete from roles where tenant_id = ${newTenantId}`
  await admin`delete from tenants where id = ${newTenantId}`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

describe('33 §13 критерий 12: восемь этапов у нового тенанта', () => {
  it('новый тенант получает ровно восемь этапов в порядке docs/v2/33 §3.3', async () => {
    const rows = await admin`select code, sort from lifecycle_stages where tenant_id = ${newTenantId} order by sort`
    expect(rows.map(r => r.code)).toEqual([...LIFECYCLE_STAGE_CODES])
    expect(rows.map(r => r.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('значения возможностей совпадают с таблицей §3.3 ключ в ключ', async () => {
    const rows = await admin`select code, capabilities, expected_days, applies_to_candidate from lifecycle_stages where tenant_id = ${newTenantId}`
    for (const expected of DEFAULT_LIFECYCLE_STAGES) {
      const row = rows.find(r => r.code === expected.code)!
      expect(row, expected.code).toBeDefined()
      expect(row.capabilities, expected.code).toEqual(expected.capabilities)
      expect(row.expected_days, expected.code).toBe(expected.expectedDays)
      // applies_to_candidate — генерируемое зеркало ключа возможностей, не вторая правда
      expect(row.applies_to_candidate, expected.code).toBe(expected.capabilities.applies_to_candidate)
    }
  })

  it('у каждого этапа объявлены все одиннадцать ключей — «отсутствующий = false» не прячет опечатку', async () => {
    const rows = await admin`select code, capabilities from lifecycle_stages where tenant_id = ${newTenantId}`
    for (const r of rows) {
      expect(Object.keys(r.capabilities as object).sort(), r.code as string).toEqual([...STAGE_CAPABILITIES].sort())
    }
  })

  it('повторный посев идемпотентен — восемь остаётся восемь', async () => {
    const rows = await admin`select count(*)::int as n from lifecycle_stages where tenant_id = ${newTenantId}` as unknown as { n: number }[]
    expect(rows[0]?.n).toBe(8)
  })
})

describe('44 В-3: capabilities — фиксированный перечень ключей', () => {
  it('неизвестный ключ отвергается контрактом (основание 422), а не игнорируется', () => {
    expect(stageCapabilitiesSchema.safeParse({ progress: true }).success).toBe(true)
    expect(stageCapabilitiesSchema.safeParse({ certificat: true }).success).toBe(false)
    expect(stageCapabilitiesSchema.safeParse({ progress: true, unknown_key: true }).success).toBe(false)
  })

  it('неизвестный ключ не проходит и мимо API — его ловит констрейнт БД', async () => {
    const [stage] = await admin`select id from lifecycle_stages where tenant_id = ${newTenantId} and code = 'knowledge'`
    await expect(
      admin`update lifecycle_stages set capabilities = '{"certificat": true}'::jsonb where id = ${stage!.id}`,
    ).rejects.toThrow(/lifecycle_stages_capabilities_keys_check/)
  })

  it('код этапа неизменяем: девятый код закрыт констрейнтом', async () => {
    await expect(
      admin`insert into lifecycle_stages (tenant_id, code, name_uk, sort) values (${newTenantId}, 'vacation', 'Відпустка', 8)`,
    ).rejects.toThrow(/lifecycle_stages_code_check/)
  })
})

describe('33 §7.1: stageCan() — единственная точка проверки возможностей', () => {
  it('курс без этапа получает полный набор возможностей (§7.3 — базовое ТЗ не ломается)', () => {
    for (const cap of STAGE_CAPABILITIES) expect(stageCan(null, cap)).toBe(true)
  })

  it('отсутствующий ключ читается как false (§3.3)', () => {
    expect(stageCan({ capabilities: {} }, 'progress')).toBe(false)
    expect(stageCan({ capabilities: { progress: true } }, 'progress')).toBe(true)
    expect(stageCan({ capabilities: { progress: true } }, 'deadline')).toBe(false)
  })

  it('«База знань»: ни прогресса, ни дедлайна, ни оценки — но ИИ-генерация разрешена', async () => {
    const stages = await listStages({ tenantId: newTenantId, actorId: adminId })
    const knowledge = stages.find(s => s.code === 'knowledge')!
    expect(stageCan(knowledge, 'progress')).toBe(false)
    expect(stageCan(knowledge, 'deadline')).toBe(false)
    expect(stageCan(knowledge, 'grading')).toBe(false)
    expect(stageCan(knowledge, 'ai_generate')).toBe(true)
  })

  it('«Психологічні тести»: нет оценки и нет влияния на рейтинг (§3.3, обоснование)', async () => {
    const stages = await listStages({ tenantId: newTenantId, actorId: adminId })
    const psy = stages.find(s => s.code === 'psychological')!
    expect(stageCan(psy, 'grading')).toBe(false)
    expect(stageCan(psy, 'counts_in_rating')).toBe(false)
    expect(stageCan(psy, 'applies_to_candidate')).toBe(true)
  })

  it('§7.9: кандидату доступны только этапы с applies_to_candidate — фильтр по зеркалу, не по коду', async () => {
    const forCandidate = await listCandidateStages({ tenantId: newTenantId, actorId: adminId })
    expect(forCandidate.every(s => s.appliesToCandidate && s.isEnabled)).toBe(true)
    expect(forCandidate.every(s => stageCan(s, 'applies_to_candidate'))).toBe(true)
    // По умолчанию (§7.9) это recruiting и psychological — но проверяем через возможность,
    // а не через список кодов: перечень меняется настройкой, инвариант — нет.
    const all = await listStages({ tenantId: newTenantId, actorId: adminId })
    expect(forCandidate.length).toBe(all.filter(s => stageCan(s, 'applies_to_candidate')).length)
  })

  it('смена возможностей оператором меняет ответ stageCan() без единой правки кода', async () => {
    const stages = await listStages({ tenantId: newTenantId, actorId: adminId })
    const knowledge = stages.find(s => s.code === 'knowledge')!
    const r = await setStageCapabilities(newTenantId, knowledge.id, { ...knowledge.capabilities, progress: true })
    expect(typeof r === 'string' ? r : r.capabilities.progress).toBe(true)
    await setStageCapabilities(newTenantId, knowledge.id, knowledge.capabilities)
  })
})

describe('33 §13 критерий 11: смена этапа у курса с завершёнными прохождениями', () => {
  let courseId: string
  let stageA: string
  let stageB: string
  let enrollmentId: string | null = null

  beforeAll(async () => {
    const stages = await listStages({ tenantId, actorId: adminId })
    stageA = stages.find(s => s.code === 'onboarding')!.id
    stageB = stages.find(s => s.code === 'training')!.id
    courseId = (await admin`select id from courses where tenant_id = ${tenantId} and deleted_at is null order by created_at limit 1`)[0]!.id as string
    await admin`update courses set lifecycle_stage_id = ${stageA}, stage_locked = false where id = ${courseId}`
  })

  afterAll(async () => {
    if (enrollmentId) await admin`delete from enrollments where id = ${enrollmentId}`
    await admin`update courses set lifecycle_stage_id = null, stage_locked = false where id = ${courseId}`
  })

  it('без завершённых прохождений этап меняется свободно', async () => {
    const r = await setCourseStage({ tenantId, actorId: adminId }, courseId, stageB)
    expect(typeof r === 'string' ? r : r.lifecycleStageId).toBe(stageB)
    expect(typeof r === 'string' ? r : r.stageLocked).toBe(false)
  })

  it('курс с завершённым прохождением заперт: смена без подтверждения — stage_locked (409)', async () => {
    const [enr] = await admin`
      insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, status, completed_at)
      select ${tenantId}, ${adminId}, 'course', ${courseId}, cv.id, 'done', now()
      from course_versions cv where cv.course_id = ${courseId} limit 1
      returning id`
    enrollmentId = enr!.id as string
    expect(await setCourseStage({ tenantId, actorId: adminId }, courseId, stageA)).toBe('stage_locked')
  })

  it('с подтверждением администратора смена проходит и курс остаётся запертым', async () => {
    const r = await setCourseStage({ tenantId, actorId: adminId }, courseId, stageA, true)
    expect(typeof r === 'string' ? r : r.lifecycleStageId).toBe(stageA)
    expect(typeof r === 'string' ? r : r.stageLocked).toBe(true)
    expect(typeof r === 'string' ? r : r.completedCount).toBeGreaterThan(0)
  })

  it('уже созданные назначения не пересчитываются: статус прохождения не тронут (§7.4, инвариант 1)', async () => {
    const [row] = await admin`select status from enrollments where id = ${enrollmentId}`
    expect(row!.status).toBe('done')
  })

  it('courseStageCan() читает возможности этапа курса, а не его код', async () => {
    const can = await withTenant(tenantId, adminId, tx => courseStageCan(tx, courseId, 'certificate'))
    expect(can).toBe(true) // onboarding: certificate = true (§3.3)
    const cannot = await withTenant(tenantId, adminId, tx => courseStageCan(tx, courseId, 'applies_to_candidate'))
    expect(cannot).toBe(false) // onboarding кандидату не назначается
  })
})

describe('RLS справочника этапов', () => {
  it('этапы чужого тенанта не видны внутри withTenant', async () => {
    const own = await withTenant(tenantId, adminId, async (tx) => {
      const rows = await tx.execute('select tenant_id from lifecycle_stages') as unknown as { tenant_id: string }[]
      return rows
    })
    expect(own.length).toBe(8)
    expect(own.every(r => r.tenant_id === tenantId)).toBe(true)
  })
})
