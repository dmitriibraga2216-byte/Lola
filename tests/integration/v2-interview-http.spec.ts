import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * ИИ-собеседование по HTTP (PR-28, образец — `v2-ai-http.spec.ts`). Сервисный слой проверяет
 * `v2-interview.spec.ts`; здесь — то, что видно только снаружи:
 * - **`30` §13 к. 1** дословно: прямой `POST …/start` без согласия — `409 interview_consent.required`,
 *   и обычный путь теста для теста-собеседования закрыт тем же кодом;
 * - **`30` §13 к. 12**: роль без `interview.listen` на ссылку прослушивания получает `403`, а
 *   строки `interview.media.listen` в журнале не появляется; с правом — ссылка и строка журнала;
 * - чужая сессия — `404`, не `403` (CLAUDE.md п. 15); кандидат без ролей проходит собеседование
 *   по данным (`41` §2.3: «— (кандидат)»).
 */
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3831
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const PHONE = '+38067993'
const MARK = 'PR28H'
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let server: ChildProcess | undefined
let tenantId: string
let adminId: string
let candidateId: string
let viewerId: string
let roleId: string
let quizId: string
let bankId: string
let recruitingWas = false
const users: string[] = []

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

describe.skipIf(!BUILT)('ИИ-собеседование по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits`
    await admin`delete from otp_codes`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    recruitingWas = (await admin`select candidates_enabled from tenants where id = ${tenantId}`)[0]!.candidates_enabled as boolean
    await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
    await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
    await admin`update tenant_limits set ai_status = 'active', status = 'active' where tenant_id = ${tenantId}`

    const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
    const candidate = { kind: 'candidate', candidate_state: 'active', candidate_status_id: status!.id, recruiter_id: adminId, comm_language: 'uk', source: 'manual' }
    candidateId = await person(1, candidate)
    await person(2, candidate)
    // Роль, которая видит собеседование, но не слушает запись (`30` §2: керівник точки)
    viewerId = await person(3, { kind: 'employee' })
    const [role] = await admin`insert into roles (tenant_id, code, name, scopes, default_scope_type)
      values (${tenantId}, ${`custom_pr28h_${Date.now()}`}, 'PR28H перегляд співбесід', array['candidate.view', 'interview.view']::text[], 'tenant') returning id`
    roleId = role!.id as string
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${viewerId}, ${roleId}, 'tenant')`

    const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк`}) returning id`
    bankId = bank!.id as string
    const [quiz] = await admin`insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
      values (${tenantId}, ${`${MARK} співбесіда`}, 'interview', 'published', 'fixed', 2) returning id`
    quizId = quiz!.id as string
    for (let i = 1; i <= 2; i++) {
      const [q] = await admin`insert into questions (tenant_id, bank_id, kind, stem) values (${tenantId}, ${bankId}, 'free', ${admin.json([{ type: 'text', html: `<p>Питання ${i}</p>` }])}) returning id`
      await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quizId}, ${q!.id}, ${i})`
    }
    for (const u of [candidateId, adminId]) {
      await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience, status, is_mandatory, created_by)
        values (${tenantId}, ${`${MARK} призначення`}, 'test', ${quizId}, ${admin.json({ rules: [{ type: 'user', ids: [u] }], match: 'any' })}, 'active', false, ${adminId})`
    }
    const [sc] = await admin`insert into interview_scenarios (tenant_id, quiz_id, name, intro_text, outro_text, alternative_path, status, answer_modes)
      values (${tenantId}, ${quizId}, ${`${MARK} сценарій`}, ${'Вітаю! '.repeat(10)}, 'Дякуємо за відповіді!!!', 'human_interview', 'published', '{voice,text}') returning id`
    await admin`insert into interview_criteria (tenant_id, scenario_id, code, name_uk, description)
      values (${tenantId}, ${sc!.id}, 'c1', 'Комунікація', 'Ясно пояснює гостю ситуацію і пропонує рішення')`

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
    await admin`update tenant_limits set status = 'trial' where tenant_id = ${tenantId}`
    if (quizId) {
      await admin`delete from interview_sessions where scenario_id in (select id from interview_scenarios where quiz_id = ${quizId})`
      await admin`delete from interview_consents where scenario_id in (select id from interview_scenarios where quiz_id = ${quizId})`
      await admin`delete from interview_scenarios where quiz_id = ${quizId}`
      await admin`delete from assignments where subject_id = ${quizId}`
      await admin`delete from attempt_answers where attempt_id in (select id from attempts where quiz_id = ${quizId})`
      await admin`delete from attempt_results where attempt_id in (select id from attempts where quiz_id = ${quizId})`
      await admin`delete from review_queue_items where user_id in ${admin(users)}`
      await admin`delete from task_access_log where content_id = ${quizId}`
      await admin`delete from attempts where quiz_id = ${quizId}`
      await admin`delete from quiz_questions where quiz_id = ${quizId}`
      await admin`delete from quizzes where id = ${quizId}`
      await admin`delete from questions where bank_id = ${bankId}`
      await admin`delete from question_banks where id = ${bankId}`
    }
    await admin`delete from usage_events where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`
    await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = 'ai_interview_ops'`
    await admin`delete from media_assets where owner_user_id in ${admin(users)}`
    await admin`delete from ai_calls where subject_user_id in ${admin(users)}`
    await admin`delete from notifications where user_id in ${admin(users)}`
    await admin`delete from user_roles where user_id in ${admin(users)}`
    if (roleId) await admin`delete from roles where id = ${roleId}`
    await admin`delete from sessions where user_id in ${admin(users)}`
    await admin`delete from users where id in ${admin(users)}`
    await admin.end()
  })

  beforeEach(async () => {
    await admin`delete from rate_limits`
  })

  it('к. 1: до согласия попытки нет — прямой start и обычный путь теста дают 409 interview_consent.required', async () => {
    const cand = await login(`${PHONE}0001`)
    const entry = await send(cand, 'GET', `/interviews/entry/${quizId}`)
    expect(entry.status).toBe(200)
    const state = ((await entry.json()) as { data: { next: string, consent: { lines: string[], textVersion: string, textHash: string } } }).data
    expect(state.next).toBe('consent')
    expect(state.consent.lines).toHaveLength(6)

    const start = await send(cand, 'POST', `/interviews/entry/${quizId}/start`, { answerMode: 'text' })
    expect(start.status).toBe(409)
    expect((await error(start)).code).toBe('interview_consent.required')

    const adm = await login(ADMIN_PHONE)
    const plain = await send(adm, 'POST', `/learning/quizzes/${quizId}/attempts`, {})
    expect(plain.status).toBe(409)
    expect((await error(plain)).code).toBe('interview_consent.required')
    expect(await admin`select id from attempts where quiz_id = ${quizId}`).toHaveLength(0)

    // С согласием — сессия; повторное решение — 409 already_decided
    const ok = await send(cand, 'POST', `/interviews/entry/${quizId}/consent`, { decision: 'accepted', textVersion: state.consent.textVersion, textHash: state.consent.textHash })
    expect(ok.status).toBe(200)
    const again = await send(cand, 'POST', `/interviews/entry/${quizId}/consent`, { decision: 'accepted', textVersion: state.consent.textVersion, textHash: state.consent.textHash })
    expect(again.status).toBe(409)
    expect((await error(again)).code).toBe('interview_consent.already_decided')
    const started = await send(cand, 'POST', `/interviews/entry/${quizId}/start`, { answerMode: 'voice' })
    expect(started.status).toBe(200)
  })

  it('к. 12: без interview.listen — 403 и нет строки журнала; с правом — ссылка на 15 минут и строка журнала', async () => {
    const cand = await login(`${PHONE}0001`)
    const [session] = await admin`select s.id from interview_sessions s where s.candidate_id = ${candidateId}`
    const sessionId = session!.id as string
    const up = await send(cand, 'POST', `/interviews/${sessionId}/turns/1/upload`, { mime: 'audio/webm', bytes: 2048 })
    expect(up.status).toBe(200)
    const { mediaId } = ((await up.json()) as { data: { mediaId: string } }).data
    const answered = await send(cand, 'POST', `/interviews/${sessionId}/turns/1/answer`, { mode: 'voice', mediaId, durationMs: 3200 })
    expect(answered.status).toBe(200)
    const [turn] = await admin`select id from interview_turns where session_id = ${sessionId} and ordinal = 1`
    const turnId = turn!.id as string
    const listens = async () => Number((await admin`select count(*)::int as n from audit_log where action = 'interview.media.listen' and entity_id = ${turnId}`)[0]!.n)

    const viewer = await login(`${PHONE}0003`)
    const view = await send(viewer, 'GET', `/candidates/${candidateId}/interview`)
    expect(view.status).toBe(200)
    const denied = await send(viewer, 'GET', `/candidates/${candidateId}/interview/media/${turnId}`)
    expect(denied.status).toBe(403)
    expect((await error(denied)).code).toBe('forbidden')
    expect(await listens()).toBe(0)

    const adm = await login(ADMIN_PHONE)
    const allowed = await send(adm, 'GET', `/candidates/${candidateId}/interview/media/${turnId}`)
    expect(allowed.status).toBe(200)
    const body = ((await allowed.json()) as { data: { url: string, expiresAt: string } }).data
    expect(body.url).toMatch(/X-Amz-Expires=900/)
    expect(await listens()).toBe(1)
  })

  it('чужая сессия — 404, не 403; отзыв согласия — 204', async () => {
    const [session] = await admin`select s.id from interview_sessions s where s.candidate_id = ${candidateId}`
    const stranger = await login(`${PHONE}0002`)
    expect((await send(stranger, 'GET', `/interviews/${session!.id}`)).status).toBe(404)
    expect((await send(stranger, 'POST', `/interviews/${session!.id}/withdraw`, {})).status).toBe(404)
    const cand = await login(`${PHONE}0001`)
    const w = await send(cand, 'POST', `/interviews/${session!.id}/withdraw`, { reason: 'передумав' })
    expect(w.status).toBe(204)
    expect((await admin`select degraded_reason from interview_sessions where id = ${session!.id}`)[0]!.degraded_reason).toBe('consent_withdrawn')
  })
})
