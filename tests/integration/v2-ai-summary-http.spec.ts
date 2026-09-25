import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-29 по HTTP (образец — `v2-interview-http.spec.ts`). Сервисный слой проверяет
 * `v2-ai-summary.spec.ts`; здесь — то, что видно только снаружи:
 * - **`30` §13 к. 14**: документ по ссылке из письма открывается **без входа** и несёт строку
 *   «Документ сформовано автоматично»; «выключить» её настройкой тенанта нельзя — такой ключ
 *   настроек ручка отклоняет `422`;
 * - публичный контур: неизвестный токен — `404`, отозванный — `410 summary.revoked`;
 * - скоупы: без `interview.override` — `403` на «Не погоджуюсь», без `ai.review.use` — `403` на
 *   подсказку; чужой кандидат — `404`, не `403` (CLAUDE.md п. 15).
 */
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3849
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const PHONE = '+38067994'
const MARK = 'PR29H'
const DISCLAIMER = 'Документ сформовано автоматично на основі відповідей кандидата.'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let adminId: string
let candidateId: string
let viewerId: string
let roleId: string
let recruitingWas = false
const users: string[] = []
const sentToken = randomBytes(24).toString('base64url')
const revokedToken = randomBytes(24).toString('base64url')

async function login(phone: string): Promise<string> {
  const req = await fetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })
  const body = await req.json() as { data: { devCode?: string } }
  if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
  const ver = await fetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: body.data.devCode }) })
  if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status}`)
  return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
}
const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
const send = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${BASE}/api/v1${path}`, {
  method,
  headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const error = async (res: Response) => ((await res.json()) as { error: { code: string, message: string } }).error

async function person(n: number, patch: Record<string, unknown>) {
  const [row] = await admin`
    insert into users ${admin({ tenant_id: tenantId, full_name: `${MARK} ${n}`, phone: `${PHONE}${String(n).padStart(4, '0')}`, status: 'active', ...patch })}
    returning id`
  users.push(row!.id as string)
  return row!.id as string
}

function summaryBody() {
  return {
    candidate: { fullName: `${MARK} 1`, vacancyTitle: null },
    progress: { items: [] },
    scores: { items: [{ kind: 'recruiter', value: 70, authorName: 'Рекрутер', at: new Date().toISOString(), aiStub: false }] },
    interview: null,
    strengthsRisks: { status: 'unavailable', strengths: [], risks: [], caveat: 'Цей розділ сформувала програма.', aiStub: false },
    incomplete: { items: [] },
    passport: { generatedAt: new Date().toISOString(), model: null, promptVersion: null, humanChecked: false, aiStub: false },
    disclaimer: { text: DISCLAIMER, humanChecked: false, humanCheckedText: 'Оцінки програми перевірено людиною: ні.' },
  }
}

describe.skipIf(!BUILT)('Підсумок, «Не погоджуюсь», підказка — по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    recruitingWas = (await admin`select candidates_enabled from tenants where id = ${tenantId}`)[0]!.candidates_enabled as boolean
    await admin`update tenants set candidates_enabled = true where id = ${tenantId}`

    const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
    candidateId = await person(1, { kind: 'candidate', candidate_state: 'active', candidate_status_id: status!.id, recruiter_id: adminId, comm_language: 'uk', source: 'manual' })
    // Видит собеседование и Підсумок, но не спорит с ИИ и не пользуется подсказкой
    viewerId = await person(2, { kind: 'employee' })
    const [role] = await admin`insert into roles (tenant_id, code, name, scopes, default_scope_type)
      values (${tenantId}, ${`custom_pr29h_${Date.now()}`}, 'PR29H перегляд', array['candidate.view', 'interview.view', 'summary.view', 'review.queue']::text[], 'tenant') returning id`
    roleId = role!.id as string
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${viewerId}, ${roleId}, 'tenant')`

    const expires = new Date(Date.now() + 30 * 86_400_000)
    const base = { tenant_id: tenantId, candidate_id: candidateId, completeness: 'partial', body: admin.json(summaryBody()), lang: 'uk', sent_at: new Date(), share_expires_at: expires, sent_channel: 'link' }
    await admin`insert into candidate_summaries ${admin({ ...base, version: 1, state: 'revoked', share_token: revokedToken, revoked_at: new Date(), revoke_reason: 'superseded', sections: admin.json(['scores']) })}`
    await admin`insert into candidate_summaries ${admin({ ...base, version: 2, state: 'sent', share_token: sentToken, sections: admin.json(['scores']) })}`

    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', WORKER_ENABLED: '0', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`update tenants set candidates_enabled = ${recruitingWas} where id = ${tenantId}`
    await admin`delete from candidate_summaries where candidate_id = ${candidateId}`
    await admin`delete from notifications where user_id in ${admin(users)}`
    await admin`delete from user_roles where user_id in ${admin(users)}`
    if (roleId) await admin`delete from roles where id = ${roleId}`
    await admin`delete from sessions where user_id in ${admin(users)}`
    await admin`delete from users where id in ${admin(users)}`
    await admin.end()
  })

  it('к. 14: документ по ссылке открывается без входа и несёт «Документ сформовано автоматично»; ПД третьих лиц нет', async () => {
    const res = await fetch(`${BASE}/api/v1/public/candidate-summaries/${sentToken}`)
    expect(res.status).toBe(200)
    const data = (await res.json() as { data: { disclaimerLine: string, document: { disclaimer: { text: string }, scores?: { items: { authorName: string | null }[] } } } }).data
    expect(data.disclaimerLine).toContain('Документ сформовано автоматично')
    expect(data.document.disclaimer.text).toBe(DISCLAIMER)
    expect(data.document.scores!.items[0]!.authorName).toBeNull()
    expect(Object.keys(data.document).sort()).toEqual(['disclaimer', 'scores'])
  })

  it('неизвестная ссылка — 404, отозванная — 410 summary.revoked', async () => {
    const unknown = await fetch(`${BASE}/api/v1/public/candidate-summaries/${randomBytes(24).toString('base64url')}`)
    expect(unknown.status).toBe(404)
    expect((await error(unknown)).code).toBe('summary.not_found')
    const revoked = await fetch(`${BASE}/api/v1/public/candidate-summaries/${revokedToken}`)
    expect(revoked.status).toBe(410)
    expect((await error(revoked)).code).toBe('summary.revoked')
  })

  it('к. 14: «выключить» строку настройкой тенанта нельзя — ключ отклоняется 422', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await send(cookie, 'PATCH', '/settings/recruiting', { summaryDisclaimer: false })
    expect(res.status).toBe(422)
    const nested = await send(cookie, 'PATCH', '/settings/recruiting', { summaryAutoSend: { hideDisclaimer: true } })
    expect(nested.status).toBe(422)
  })

  it('без interview.override — 403 на «Не погоджуюсь»; чужой кандидат для админа — 404', async () => {
    const viewer = await login(`${PHONE}0002`)
    const denied = await send(viewer, 'POST', `/candidates/${candidateId}/interview/criteria/${randomUuid()}/override`, { humanValue: 2, humanComment: 'Не згоден з оцінкою програми' })
    expect(denied.status).toBe(403)
    const cookie = await login(ADMIN_PHONE)
    const missing = await send(cookie, 'POST', `/candidates/${randomUuid()}/interview/criteria/${randomUuid()}/override`, { humanValue: 2, humanComment: 'Не згоден з оцінкою програми' })
    expect(missing.status).toBe(404)
  })

  it('без ai.review.use — 403 на подсказку; без подсказки — 404 hint.absent', async () => {
    const viewer = await login(`${PHONE}0002`)
    expect((await send(viewer, 'GET', `/review-hints/attempt_answer/${randomUuid()}`)).status).toBe(403)
    const cookie = await login(ADMIN_PHONE)
    const absent = await send(cookie, 'GET', `/review-hints/attempt_answer/${randomUuid()}`)
    expect(absent.status).toBe(404)
    expect((await error(absent)).code).toBe('hint.absent')
  })
})

function randomUuid(): string {
  return randomUUID()
}
