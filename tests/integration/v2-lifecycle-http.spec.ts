import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Этапы жизненного цикла по HTTP (PR-05 пакета `docs/v2`, образец — `spec24-http.spec.ts`).
 *
 * Главное здесь — код ответа, а не факт записи (`docs/v2/44-decisions.md` В-3):
 * неизвестный ключ `capabilities` отвергается `422`, а не игнорируется; тенант возможности
 * вообще не меняет — `403 capabilities.readonly` (`docs/v2/33-lifecycle.md` §2, §10);
 * `code` неизменяем; смена этапа у курса с завершёнными прохождениями без подтверждения —
 * `409 course.stage_locked` (критерий §13 п. 11).
 */
const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3797
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'
const OPS_EMAIL = 'ops-v2-05-http@lola.local'
const OPS_PASSWORD = 'test-password-123'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let otherTenantId: string
let foreignStageId: string
let courseId: string
let enrollmentId: string | null = null

async function login(phone: string): Promise<string> {
  const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const body = await req.json() as { data: { devCode?: string } }
  if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
  const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
  if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
  return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

interface Stage { id: string, code: string, nameUk: string, isEnabled: boolean, capabilities: Record<string, boolean>, coursesCount: number }

describe.skipIf(!BUILT)('Этапы жизненного цикла по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    courseId = (await admin`select id from courses where tenant_id = ${tenantId} and deleted_at is null order by created_at limit 1`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-lifecycle-isolation', 'Тест ізоляції етапів') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    foreignStageId = (await admin`
      insert into lifecycle_stages (tenant_id, code, name_uk, sort, capabilities)
      values (${otherTenantId}, 'onboarding', 'Чужий етап', 0, '{"progress": true}'::jsonb)
      on conflict (tenant_id, code) do update set name_uk = excluded.name_uk returning id`)[0]!.id as string
    await admin`delete from platform_admins where email = ${OPS_EMAIL}`

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, PLATFORM_ADMIN_EMAIL: OPS_EMAIL, PLATFORM_ADMIN_PASSWORD: OPS_PASSWORD }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    if (enrollmentId) await admin`delete from enrollments where id = ${enrollmentId}`
    await admin`update courses set lifecycle_stage_id = null, stage_locked = false where id = ${courseId}`
    await admin`update lifecycle_stages set name_uk = 'База знань', is_enabled = true where tenant_id = ${tenantId} and code = 'knowledge'`
    await admin`delete from lifecycle_stages where tenant_id = ${otherTenantId}`
    await admin`delete from tenants where id = ${otherTenantId}`
    await admin`delete from audit_log where tenant_id = ${tenantId} and action in ('lifecycle.stage_updated', 'course.stage_changed', 'lifecycle.capabilities_changed')`
    await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
    await admin`delete from platform_admins where email = ${OPS_EMAIL}`
    await admin.end()
  })

  beforeEach(async () => { await admin`delete from rate_limits` })
  afterEach(async () => { await admin`delete from rate_limits` })

  it('GET /settings/lifecycle-stages — восемь этапов с возможностями', async () => {
    const adm = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } })
    expect(res.status).toBe(200)
    const stages = await data<Stage[]>(res)
    expect(stages.length).toBe(8)
    expect(stages.map(s => s.code)).toEqual(['recruiting', 'onboarding', 'integration', 'training', 'attestation', 'psychological', 'knowledge', 'offboarding'])
    expect(stages.find(s => s.code === 'knowledge')!.capabilities.progress).toBe(false)
  })

  it('сотруднику справочник не отдаётся — нет скоупа lifecycle.view', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: emp } })).status).toBe(403)
  })

  it('capabilities с неизвестным ключом → 422 validation_failed (В-3: не игнорируется)', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const knowledge = stages.find(s => s.code === 'knowledge')!
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${knowledge.id}`, json(adm, 'PATCH', { capabilities: { certificat: true } }))
    expect(res.status).toBe(422)
    expect(await errCode(res)).toBe('validation_failed')
  })

  it('известные capabilities от тенанта → 403 capabilities.readonly (§2: набор задаёт платформа)', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const knowledge = stages.find(s => s.code === 'knowledge')!
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${knowledge.id}`, json(adm, 'PATCH', { capabilities: { progress: true } }))
    expect(res.status).toBe(403)
    expect(await errCode(res)).toBe('capabilities.readonly')
    const after = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    expect(after.find(s => s.code === 'knowledge')!.capabilities.progress).toBe(false)
  })

  it('code менять нельзя — поле не принимается контрактом (422)', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const knowledge = stages.find(s => s.code === 'knowledge')!
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${knowledge.id}`, json(adm, 'PATCH', { code: 'onboarding' }))
    expect(res.status).toBe(422)
    const after = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    expect(after.find(s => s.id === knowledge.id)!.code).toBe('knowledge')
  })

  it('название и норму времени тенант правит сам', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const knowledge = stages.find(s => s.code === 'knowledge')!
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${knowledge.id}`, json(adm, 'PATCH', { nameUk: 'Довідник' }))
    expect(res.status).toBe(200)
    expect((await data<Stage>(res)).nameUk).toBe('Довідник')
  })

  it('чужой этап — 404, не 403 (CLAUDE.md п. 15)', async () => {
    const adm = await login(ADMIN_PHONE)
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${foreignStageId}`, json(adm, 'PATCH', { nameUk: 'Спроба' }))
    expect(res.status).toBe(404)
    const [row] = await admin`select name_uk from lifecycle_stages where id = ${foreignStageId}`
    expect(row!.name_uk).toBe('Чужий етап')
  })

  it('оператор платформы меняет возможности; неизвестный ключ и у него → 422', async () => {
    const opsLogin = await fetch(`${BASE}/api/v1/platform/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OPS_EMAIL, password: OPS_PASSWORD }) })
    expect(opsLogin.status).toBe(200)
    const ops = opsLogin.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
    const [stage] = await admin`select id, capabilities from lifecycle_stages where tenant_id = ${tenantId} and code = 'knowledge'`
    const before = stage!.capabilities as Record<string, boolean>

    const bad = await fetch(`${BASE}/api/v1/platform/tenants/${tenantId}/lifecycle-stages/${stage!.id}`, { method: 'PATCH', headers: { 'cookie': ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilities: { certificat: true } }) })
    expect(bad.status).toBe(422)
    expect(await errCode(bad)).toBe('validation_failed')

    const ok = await fetch(`${BASE}/api/v1/platform/tenants/${tenantId}/lifecycle-stages/${stage!.id}`, { method: 'PATCH', headers: { 'cookie': ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilities: { ...before, progress: true } }) })
    expect(ok.status).toBe(200)
    expect((await data<Stage>(ok)).capabilities.progress).toBe(true)

    await fetch(`${BASE}/api/v1/platform/tenants/${tenantId}/lifecycle-stages/${stage!.id}`, { method: 'PATCH', headers: { 'cookie': ops, 'Content-Type': 'application/json' }, body: JSON.stringify({ capabilities: before }) })
  })

  it('33 §13 критерий 11: смена этапа у курса с завершёнными прохождениями без подтверждения → 409', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const onboarding = stages.find(s => s.code === 'onboarding')!
    const training = stages.find(s => s.code === 'training')!

    const first = await fetch(`${BASE}/api/v1/courses/${courseId}/stage`, json(adm, 'PATCH', { lifecycleStageId: onboarding.id }))
    expect(first.status).toBe(200)

    const userId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${EMPLOYEE_PHONE}`)[0]!.id as string
    const [enr] = await admin`
      insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, status, completed_at)
      select ${tenantId}, ${userId}, 'course', ${courseId}, cv.id, 'done', now()
      from course_versions cv where cv.course_id = ${courseId} limit 1
      returning id`
    enrollmentId = enr!.id as string

    const locked = await fetch(`${BASE}/api/v1/courses/${courseId}/stage`, json(adm, 'PATCH', { lifecycleStageId: training.id }))
    expect(locked.status).toBe(409)
    expect(await errCode(locked)).toBe('course.stage_locked')

    const confirmed = await fetch(`${BASE}/api/v1/courses/${courseId}/stage`, json(adm, 'PATCH', { lifecycleStageId: training.id, confirm: true }))
    expect(confirmed.status).toBe(200)
  })

  it('выключенный этап курсу не присваивается — 422 lifecycle.disabled (§7.10)', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const offboarding = stages.find(s => s.code === 'offboarding')!
    await admin`update lifecycle_stages set is_enabled = false where id = ${offboarding.id}`
    const res = await fetch(`${BASE}/api/v1/courses/${courseId}/stage`, json(adm, 'PATCH', { lifecycleStageId: offboarding.id, confirm: true }))
    expect(res.status).toBe(422)
    expect(await errCode(res)).toBe('lifecycle.disabled')
    await admin`update lifecycle_stages set is_enabled = true where id = ${offboarding.id}`
  })

  it('33 §13 критерий 8: выключение этапа с курсами → 409 lifecycle_stage.in_use', async () => {
    const adm = await login(ADMIN_PHONE)
    const stages = await data<Stage[]>(await fetch(`${BASE}/api/v1/settings/lifecycle-stages`, { headers: { cookie: adm } }))
    const training = stages.find(s => s.code === 'training')!
    expect(training.coursesCount).toBeGreaterThan(0)
    const res = await fetch(`${BASE}/api/v1/settings/lifecycle-stages/${training.id}`, json(adm, 'PATCH', { isEnabled: false }))
    expect(res.status).toBe(409)
    expect(await errCode(res)).toBe('lifecycle_stage.in_use')
  })
})
