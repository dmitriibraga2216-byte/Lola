import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Spec 20 по HTTP (по образцу scopes-http.spec.ts): анкета/чек-лист/опрос после первого заполнения — 409 с объяснением;
 * скоупы (employee не создаёт анкеты и опросы); прохождение опроса сервером по одному вопросу — граф переходов
 * клиенту не отдаётся; чужой тенант — 404.
 */

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3796
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PHONE = '+380661864742'
const EMPLOYEE_PHONE = '+380670000003'

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let server: ChildProcess | undefined
let tenantId: string
let scaleId: string
let otherTenantId: string
let foreignFormId: string
let foreignScaleId: string
const surveyIds: string[] = []
const checklistIds: string[] = []
const formIds: string[] = []
const groupIds: string[] = []

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
const errOf = async (res: Response) => ((await res.json()) as { error: { code: string, message: string, details?: Record<string, unknown> } }).error

describe.skipIf(!BUILT)('Spec 20 по HTTP', () => {
  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE})`
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    scaleId = (await admin`select id from scales where tenant_id = ${tenantId} and name = '1–5'`)[0]!.id as string
    const [other] = await admin`insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції') on conflict (slug) do update set name = excluded.name returning id`
    otherTenantId = other!.id as string
    foreignScaleId = (await admin`insert into scales (tenant_id, name, kind) values (${otherTenantId}, ${`Чужа s20 ${Date.now()}`}, 'levels') returning id`)[0]!.id as string
    foreignFormId = (await admin`insert into assessment_forms (tenant_id, title, scale_id) values (${otherTenantId}, 'Чужа анкета', ${foreignScaleId}) returning id`)[0]!.id as string
    server = spawn('node', ['.output/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL }, stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 30 секунд')
  }, 90_000)
  afterAll(async () => {
    server?.kill()
    if (surveyIds.length) await admin`delete from surveys where id in ${admin(surveyIds)}`
    if (checklistIds.length) { await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`; await admin`delete from checklists where id in ${admin(checklistIds)}` }
    if (formIds.length) await admin`delete from assessment_forms where id in ${admin(formIds)}`
    if (groupIds.length) await admin`delete from criteria_groups where id in ${admin(groupIds)}`
    await admin`delete from assessment_forms where id = ${foreignFormId}`
    await admin`delete from scales where id = ${foreignScaleId}`
    await admin.end()
  })
  beforeEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })
  afterEach(async () => { await admin`delete from rate_limits where key like ${'otp:%'}` })

  it('скоупы: employee не создаёт анкеты, чек-листы и опросы; чужая анкета — 404, чужая шкала в анкете — 422', async () => {
    const emp = await login(EMPLOYEE_PHONE)
    expect((await fetch(`${BASE}/api/v1/assessment/forms`, json(emp, 'PUT', { title: 'x' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/checklists`, json(emp, 'PUT', { title: 'x' }))).status).toBe(403)
    expect((await fetch(`${BASE}/api/v1/surveys`, json(emp, 'POST', { title: 'x' }))).status).toBe(403)
    const adm = await login(ADMIN_PHONE)
    expect((await fetch(`${BASE}/api/v1/assessment/forms/${foreignFormId}`, { headers: { cookie: adm } })).status).toBe(404)
    const g = await data<{ id: string }>(await fetch(`${BASE}/api/v1/assessment/groups`, json(adm, 'PUT', { name: `HTTP група ${Date.now()}`, tags: ['soft'] })))
    groupIds.push(g.id)
    const c = await data<{ id: string }>(await fetch(`${BASE}/api/v1/assessment/criteria`, json(adm, 'PUT', { groupId: g.id, text: 'Критерій' })))
    const bad = await fetch(`${BASE}/api/v1/assessment/forms`, json(adm, 'PUT', { title: 'Чужа шкала', scaleId: foreignScaleId, items: [{ criterionId: c.id, norm: 1 }] }))
    expect(bad.status).toBe(422)
    expect((await errOf(bad)).code).toBe('form.bad_scale')
  })

  it('заморозка анкеты: после первого ответа правка норм — 409 form.locked с полями; название — 200', async () => {
    const adm = await login(ADMIN_PHONE)
    const g = await data<{ id: string }>(await fetch(`${BASE}/api/v1/assessment/groups`, json(adm, 'PUT', { name: `Заморозка ${Date.now()}` })))
    groupIds.push(g.id)
    const c = await data<{ id: string }>(await fetch(`${BASE}/api/v1/assessment/criteria`, json(adm, 'PUT', { groupId: g.id, text: 'Вислуховує до кінця' })))
    const body = { title: `Анкета HTTP ${Date.now()}`, scaleId, kind: 'by_criteria', items: [{ criterionId: c.id, norm: 3 }] }
    const f = await data<{ id: string, isLocked: boolean }>(await fetch(`${BASE}/api/v1/assessment/forms`, json(adm, 'PUT', body)))
    formIds.push(f.id)
    expect(f.isLocked).toBe(false)
    // цикл: сам себя оценивает администратор
    const adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = ${ADMIN_PHONE}`)[0]!.id as string
    const cycle = await data<{ id: string }>(await fetch(`${BASE}/api/v1/assessment/cycles`, json(adm, 'POST', { title: 'Цикл HTTP', formId: f.id, periodFrom: '2026-07-01', periodTo: '2026-09-30', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(), subjects: { rules: [{ type: 'user', ids: [adminId] }], match: 'any' }, raterKinds: ['self'] })))
    expect((await fetch(`${BASE}/api/v1/assessment/cycles/${cycle.id}/start`, json(adm, 'POST'))).status).toBe(200)
    const tasks = await data<{ rating: { id: string, cycle_id: string }[] }>(await fetch(`${BASE}/api/v1/assessment/my-tasks`, { headers: { cookie: adm } }))
    const task = tasks.rating.find(t => t.cycle_id === cycle.id)!
    // оценка вне шкалы — 422
    expect((await fetch(`${BASE}/api/v1/assessment/tasks/${task.id}`, json(adm, 'PUT', { answers: [{ criterionId: c.id, value: 9 }] }))).status).toBe(422)
    expect((await fetch(`${BASE}/api/v1/assessment/tasks/${task.id}`, json(adm, 'PUT', { answers: [{ criterionId: c.id, value: 2 }] }))).status).toBe(200)
    // ниже нормы без комментария — 422 с criterionIds
    const sub = await fetch(`${BASE}/api/v1/assessment/tasks/${task.id}/submit`, json(adm, 'POST'))
    expect(sub.status).toBe(422)
    expect(await errOf(sub)).toMatchObject({ code: 'assessment.comment_required', details: { criterionIds: [c.id] } })
    // анкета заморожена
    const locked = await fetch(`${BASE}/api/v1/assessment/forms`, json(adm, 'PUT', { ...body, id: f.id, items: [{ criterionId: c.id, norm: 4 }] }))
    expect(locked.status).toBe(409)
    const e = await errOf(locked)
    expect(e.code).toBe('form.locked')
    expect(e.message).toContain('Заповнення вже почалось')
    expect(e.details?.fields).toEqual(['norms'])
    expect((await fetch(`${BASE}/api/v1/assessment/forms`, json(adm, 'PUT', { ...body, id: f.id, title: 'Нова назва' }))).status).toBe(200)
    expect((await fetch(`${BASE}/api/v1/assessment/criteria/${c.id}`, json(adm, 'DELETE'))).status).toBe(409)
    await admin`delete from assessment_cycles where id = ${cycle.id}`
  })

  it('чек-лист: после первого прогона изменение весов — 409 checklist.locked; название — 200', async () => {
    const adm = await login(ADMIN_PHONE)
    const body = { title: `Чек-лист HTTP ${Date.now()}`, scaleId, scoring: 'points', passScore: 80, whoCanRun: { roles: ['manager', 'admin'] }, items: [{ id: 'a', text: 'Вітрина', weight: 3 }, { id: 'b', text: 'Форма', weight: 2 }] }
    const c = await data<{ id: string, isLocked: boolean }>(await fetch(`${BASE}/api/v1/checklists`, json(adm, 'PUT', body)))
    checklistIds.push(c.id)
    expect(c.isLocked).toBe(false)
    expect((await fetch(`${BASE}/api/v1/checklists/${c.id}/runs`, json(adm, 'POST', {}))).status).toBe(200)
    const locked = await fetch(`${BASE}/api/v1/checklists`, json(adm, 'PUT', { ...body, id: c.id, items: [{ id: 'a', text: 'Вітрина', weight: 5 }, { id: 'b', text: 'Форма', weight: 2 }] }))
    expect(locked.status).toBe(409)
    expect(await errOf(locked)).toMatchObject({ code: 'checklist.locked', details: { fields: ['items'] } })
    expect((await fetch(`${BASE}/api/v1/checklists`, json(adm, 'PUT', { ...body, id: c.id, title: 'Чек-лист зміни · Б10' }))).status).toBe(200)
  })

  it('опрос «з умовами»: сервер отдаёт по одному вопросу без графа переходов; анонимный ответ без автора; после ответа правка вопросов — 409', async () => {
    const adm = await login(ADMIN_PHONE)
    const s = await data<{ id: string }>(await fetch(`${BASE}/api/v1/surveys`, json(adm, 'POST', {
      title: `Опитування HTTP ${Date.now()}`, mode: 'conditional', isAnonymous: true,
      questions: [
        { id: 'q1', type: 'single', text: 'Ти, як лідер, хочеш приймати рішення самостійно чи колективно?', options: [{ id: 'a', text: 'Самостійно' }, { id: 'b', text: 'Колективно' }], allowOwnOption: true, next: [{ optionId: 'a', goTo: 'q3' }] },
        { id: 'q2', type: 'free', text: 'Чому колективно?' },
        { id: 'q3', type: 'scale', text: 'Наскільки впевнені?', scaleId },
      ],
    })))
    surveyIds.push(s.id)
    expect((await fetch(`${BASE}/api/v1/surveys/${s.id}`, json(adm, 'PATCH', { status: 'active' }))).status).toBe(200)
    const emp = await login(EMPLOYEE_PHONE)
    const st = await data<{ question: Record<string, unknown>, index: number, total: number, isAnonymous: boolean }>(await fetch(`${BASE}/api/v1/learning/surveys/${s.id}/start`, json(emp, 'POST', {})))
    expect(st).toMatchObject({ index: 1, total: 3, isAnonymous: true, question: { id: 'q1' } })
    expect('next' in st.question).toBe(false)
    const bad = await fetch(`${BASE}/api/v1/learning/surveys/${s.id}/answer`, json(emp, 'POST', { questionId: 'q1', answer: { optionId: 'zzz' } }))
    expect(bad.status).toBe(422)
    expect((await errOf(bad)).code).toBe('survey.bad_option')
    const n1 = await data<{ done: boolean, question: { id: string, scale: { options: unknown[] } | null } }>(await fetch(`${BASE}/api/v1/learning/surveys/${s.id}/answer`, json(emp, 'POST', { questionId: 'q1', answer: { optionId: 'a' } })))
    expect(n1).toMatchObject({ done: false, question: { id: 'q3' } })
    expect(n1.question.scale?.options.length).toBe(5)
    const fin = await data<{ done: boolean }>(await fetch(`${BASE}/api/v1/learning/surveys/${s.id}/answer`, json(emp, 'POST', { questionId: 'q3', answer: { value: 4 } })))
    expect(fin.done).toBe(true)
    const [row] = await admin`select user_id, path from survey_responses where survey_id = ${s.id}`
    expect(row!.user_id).toBeNull()
    expect(row!.path).toEqual(['q1', 'q3'])
    expect((await fetch(`${BASE}/api/v1/learning/surveys/${s.id}/start`, json(emp, 'POST', {}))).status).toBe(409)
    const locked = await fetch(`${BASE}/api/v1/surveys/${s.id}`, json(adm, 'PATCH', { questions: [{ id: 'q1', type: 'free', text: 'Інше питання' }] }))
    expect(locked.status).toBe(409)
    expect(await errOf(locked)).toMatchObject({ code: 'survey.locked', details: { fields: ['questions'] } })
    expect((await fetch(`${BASE}/api/v1/surveys/${s.id}`, json(adm, 'PATCH', { title: 'Нова назва' }))).status).toBe(200)
    // employee не видит сводку
    expect((await fetch(`${BASE}/api/v1/surveys/${s.id}/report`, { headers: { cookie: emp } })).status).toBe(403)
  })
})
