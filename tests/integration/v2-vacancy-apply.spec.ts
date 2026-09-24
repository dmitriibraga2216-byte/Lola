import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * PR-16 пакета `docs/v2` (`45-plan.md`): публичный контур и отклик
 * (`29-vacancies.md` §3.9, §6.3, §7.1–§7.8, §7.20; решение `44` В-9, патч П-25.3).
 *
 * Критерии приёмки `29` §13, закреплённые за этим PR:
 * - **2** — публичная страница отдаёт вакансию без курса, рекрутера и внутренних
 *   идентификаторов; вилка видна только при `salary_visible`;
 * - **3** — отправка через секунду после выдачи nonce: обычный ответ, отклик в
 *   `pending_review` с причиной `fast_submit`, кандидат не создан;
 * - **4** — заполненный honeypot: `spam_score ≥ 60`, отклик придержан, ответ тот же;
 * - **5** — четвёртый отклик с одного адреса за час заблокирован, в `public_apply_attempts`
 *   есть `submit_blocked` с причиной `ip_hour`, ответ внешне неотличим от успешного;
 * - **6** — код не введён сутки: отклик `expired`, кандидат не создан, ось
 *   `candidates_active` не изменилась;
 * - **7** — подтверждённый отклик даёт `users` с `kind='candidate'`, `source='vacancy_link'`,
 *   `consent_given_at` из формы и **ровно одну** `assignments` по шаблону вакансии.
 *
 * Плюс условия выхода PR-16: сквозная проверка 16 (`42` §5) — чужой токен отдаёт `404`,
 * а не `403` и не данные; приём откликов блокируется при исчерпании оси `candidates_active`
 * (и отклик при этом не теряется); RLS отделяет отклики разных пространств.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'
// Код подтверждения возвращается вызывающему только в dev и CI — как у входа по коду.
process.env.OTP_DEBUG = '1'

const {
  publicVacancy, submitApplication, confirmApplication, expireApplications,
  pruneApplyAttempts, listApplications, acceptApplication, rejectApplication,
  markSpamApplication, signNonce, ipHash,
} = await import('../../server/services/publicApply')
const { createVacancy, publishVacancy, viewerOf } = await import('../../server/services/vacancies')
const { measureLive } = await import('../../server/services/usageCounters')
const { invalidateLimits } = await import('../../server/services/tenantLimits')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-16 '
const PHONE_BASE = '+38067992'
const IP = '203.0.113.7'

let tenantId: string
let otherTenantId: string
let adminId: string
let recruiterId: string
let courseId: string
let locationId: string
let ctx: { tenantId: string, actorId: string }
let hr: ReturnType<typeof viewerOf>

function phone(n: number): string {
  return `${PHONE_BASE}${String(n).padStart(4, '0')}`
}

/**
 * Частотные счётчики живут в общей таблице `rate_limits` и переживают тест: без уборки
 * критерий 5 («четвёртый отклик за час») зависел бы от порядка запуска файлов.
 */
async function resetLimits() {
  await admin`delete from rate_limits where key like 'apply:%'`
}

async function cleanup() {
  await resetLimits()
  const vs = await admin`select id from vacancies where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`delete from public_apply_attempts where vacancy_id = ${v.id}`
    await admin`delete from vacancy_applications where vacancy_id = ${v.id}`
    await admin`update users set vacancy_id = null where vacancy_id = ${v.id}`
  }
  const people = await admin`select id from users where phone like ${`${PHONE_BASE}%`}`
  for (const p of people) {
    await admin`delete from candidate_status_history where candidate_id = ${p.id}`
    await admin`delete from candidate_scores where candidate_id = ${p.id}`
    await admin`delete from enrollments where user_id = ${p.id}`
    await admin`delete from notifications where user_id = ${p.id}`
    await admin`delete from audit_log where entity_id = ${p.id}`
    await admin`delete from users where id = ${p.id}`
  }
  await admin`delete from assignments where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin`delete from otp_codes where phone like ${`${PHONE_BASE}%`}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'vacancy_%'`
}

/** Опубликованная вакансия с курсом, точкой и рекрутером — иначе ссылки не существует (§7.1). */
async function newVacancy(over: Record<string, unknown> = {}): Promise<{ id: string, token: string }> {
  const created = await createVacancy(ctx, {
    title: `${PREFIX}Бариста`,
    courseId,
    locationId,
    recruiterId,
    salaryCurrency: 'UAH',
    salaryVisible: false,
    publicApplyOtp: true,
    applyDailyCap: 200,
    assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: true },
    ...over,
  } as Parameters<typeof createVacancy>[1])
  const published = await publishVacancy(hr, created.id)
  expect(published.ok, `вакансия не опубликовалась: ${JSON.stringify(published)}`).toBe(true)
  const [row] = await admin`select public_token from vacancies where id = ${created.id}`
  return { id: created.id, token: row!.public_token as string }
}

/** Отклик «как человек»: форма заполнялась десять секунд, honeypot пуст. */
function humanBody(vacancyId: string, n: number, over: Record<string, unknown> = {}) {
  return {
    fullName: `Олена Петренко${n}`,
    phone: phone(n),
    consent: true as const,
    formNonce: signNonce(vacancyId, Date.now() - 10_000),
    ...over,
  } as Parameters<typeof submitApplication>[1]
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish'], scopeType: 'tenant', scopeId: null }] })
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

beforeEach(resetLimits)

describe('публичная страница вакансии (критерий §13 к. 2)', () => {
  it('отдаёт вакансию по токену без курса, рекрутера и внутренних идентификаторов', async () => {
    const v = await newVacancy({ city: 'Київ', employmentType: 'shift', workFormat: 'on_site' })
    const r = await publicVacancy(v.token, { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.vacancy.title).toContain('Бариста')
    expect(r.vacancy.city).toBe('Київ')
    const payload = JSON.stringify(r.vacancy)
    expect(payload, 'наружу ушёл идентификатор курса').not.toContain(courseId)
    expect(payload, 'наружу ушёл рекрутер').not.toContain(recruiterId)
    expect(payload, 'наружу ушла сама вакансия по id').not.toContain(v.id)
  })

  it('вилка видна только при salary_visible', async () => {
    const hidden = await newVacancy({ salaryFrom: '20000', salaryTo: '30000', salaryVisible: false })
    const shown = await newVacancy({ title: `${PREFIX}Бариста-2`, salaryFrom: '20000', salaryTo: '30000', salaryVisible: true })
    expect((await publicVacancy(hidden.token, { ip: IP }) as { vacancy: { salary: unknown } }).vacancy.salary).toBeNull()
    expect((await publicVacancy(shown.token, { ip: IP }) as { vacancy: { salary: { currency: string } } }).vacancy.salary?.currency).toBe('UAH')
  })

  it('каждый просмотр оставляет строку журнала — без неё блокировку не объяснить', async () => {
    const v = await newVacancy()
    await publicVacancy(v.token, { ip: IP })
    const rows = await admin`select outcome from public_apply_attempts where vacancy_id = ${v.id} and outcome = 'view'`
    expect(rows.length).toBe(1)
  })

  it('язык страницы — вакансии, иначе пространства (§7.20)', async () => {
    const own = await newVacancy({ publicLanguage: 'en' })
    const inherited = await newVacancy({ title: `${PREFIX}Бариста-3` })
    expect((await publicVacancy(own.token, { ip: IP }) as { vacancy: { language: string } }).vacancy.language).toBe('en')
    const [t] = await admin`select locale from tenants where id = ${tenantId}`
    expect((await publicVacancy(inherited.token, { ip: IP }) as { vacancy: { language: string } }).vacancy.language).toBe(t!.locale)
  })
})

describe('изоляция публичного контура (сквозная проверка 16, критерий §13 к. 14)', () => {
  it('несуществующий токен — 404, без подробностей', async () => {
    const r = await publicVacancy('aaaaaaaaaaaaaaaaaaaaaa', { ip: IP })
    expect(r).toEqual({ ok: false, code: 'not_found' })
  })

  it('токен чужого тенанта не отдаёт ни данных, ни признака существования', async () => {
    const v = await newVacancy()
    // Вакансия того же токена, но принадлежащая другому пространству: снаружи контур обязан
    // вести себя одинаково — он вообще не знает, «свой» ли запрос, сессии-то нет.
    const [foreign] = await admin`
      insert into vacancies (tenant_id, title, state, public_token, public_enabled, course_id, location_id)
      values (${otherTenantId}, ${`${PREFIX}Чужа`}, 'draft', ${'zzzzzzzzzzzzzzzzzzzzzz'}, false, null, null)
      returning id`
    const r = await publicVacancy('zzzzzzzzzzzzzzzzzzzzzz', { ip: IP })
    expect(r).toEqual({ ok: false, code: 'not_found' })
    // И наоборот: свой токен работает — значит 404 выше именно про изоляцию, а не про поломку
    expect((await publicVacancy(v.token, { ip: IP })).ok).toBe(true)
    await admin`delete from vacancies where id = ${foreign!.id}`
  })

  it('приостановленная вакансия — 410, а не 404: ссылка была настоящей', async () => {
    const v = await newVacancy()
    await admin`update vacancies set state = 'paused' where id = ${v.id}`
    expect(await publicVacancy(v.token, { ip: IP })).toEqual({ ok: false, code: 'gone' })
  })

  it('отклик одного пространства не виден другому даже админом (RLS)', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 11), { ip: IP })
    const mine = await listApplications(ctx, v.id, { limit: 50 })
    expect(mine?.length).toBe(1)
    const theirs = await withTenant(otherTenantId, null, async tx =>
      (await tx.execute(`select id from vacancy_applications`) as unknown as unknown[]).length)
    expect(theirs, 'чужой тенант видит отклики').toBe(0)
  })
})

describe('приём отклика: проверки §7.6–§7.7', () => {
  it('к. 3 — отправка через секунду после выдачи nonce: обычный ответ, pending_review, кандидата нет', async () => {
    const v = await newVacancy()
    const page = await publicVacancy(v.token, { ip: IP })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    const r = await submitApplication(v.token, {
      fullName: 'Олена Петренко',
      phone: phone(21),
      consent: true,
      formNonce: page.vacancy.formNonce,
    } as Parameters<typeof submitApplication>[1], { ip: IP })
    expect(r.ok, 'ответ обязан быть обычным — форма не сообщает о проверке').toBe(true)
    const [app] = await admin`select state, spam_reasons, spam_score, candidate_id from vacancy_applications where vacancy_id = ${v.id}`
    expect(app!.state).toBe('pending_review')
    expect(app!.spam_reasons).toContain('fast_submit')
    expect(app!.candidate_id, 'кандидат не должен появиться').toBeNull()
    const people = await admin`select id from users where phone = ${phone(21)}`
    expect(people.length).toBe(0)
  })

  it('к. 4 — заполненный honeypot: score ≥ 60, отклик придержан, ответ тот же', async () => {
    const v = await newVacancy()
    const r = await submitApplication(v.token, humanBody(v.id, 22, { website: 'https://spam.example' }), { ip: IP })
    expect(r.ok).toBe(true)
    const [app] = await admin`select state, spam_score from vacancy_applications where vacancy_id = ${v.id}`
    expect(Number(app!.spam_score)).toBeGreaterThanOrEqual(60)
    expect(['pending_review', 'spam']).toContain(app!.state)
    expect((await admin`select id from users where phone = ${phone(22)}`).length).toBe(0)
  })

  it('к. 5 — четвёртый отклик с одного адреса за час блокируется, и это видно в журнале', async () => {
    const v = await newVacancy()
    // Три успешных отклика — потолок §7.4. Разные вакансии, потому что правило «один отклик
    // на вакансию в сутки» иначе сработает раньше часового.
    const vs = [v, await newVacancy({ title: `${PREFIX}Бариста-б` }), await newVacancy({ title: `${PREFIX}Бариста-в` })]
    for (const [i, vac] of vs.entries()) {
      const r = await submitApplication(vac.token, humanBody(vac.id, 30 + i), { ip: IP })
      expect(r.ok).toBe(true)
    }
    const fourth = await newVacancy({ title: `${PREFIX}Бариста-г` })
    const r = await submitApplication(fourth.token, humanBody(fourth.id, 34), { ip: IP })
    expect(r.ok, 'ответ на заблокированный отклик обязан быть неотличим от успешного').toBe(true)

    const blocked = await admin`
      select outcome, reason from public_apply_attempts
       where vacancy_id = ${fourth.id} and outcome = 'submit_blocked'`
    expect(blocked.length).toBe(1)
    expect(blocked[0]!.reason).toBe('ip_hour')
    const [app] = await admin`select state, spam_reasons from vacancy_applications where vacancy_id = ${fourth.id}`
    expect(app!.state).toBe('pending_review')
    expect(app!.spam_reasons).toContain('ip_hour')
    expect((await admin`select id from users where phone = ${phone(34)}`).length).toBe(0)
  })

  it('другой адрес под тот же час не задет: правило считает адрес, а не вакансию', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 41), { ip: IP })
    const other = await newVacancy({ title: `${PREFIX}Бариста-д` })
    const r = await submitApplication(other.token, humanBody(other.id, 42), { ip: '198.51.100.4' })
    expect(r.ok).toBe(true)
    const rows = await admin`select outcome from public_apply_attempts where vacancy_id = ${other.id} and outcome = 'submit_blocked'`
    expect(rows.length).toBe(0)
  })

  it('протухшая форма — единственный честный отказ: человеку нужно обновить страницу', async () => {
    const v = await newVacancy()
    const stale = signNonce(v.id, Date.now() - 2 * 3600 * 1000)
    const r = await submitApplication(v.token, humanBody(v.id, 43, { formNonce: stale }), { ip: IP })
    expect(r).toEqual({ ok: false, code: 'nonce_stale' })
  })

  it('сырой IP нигде не хранится — только HMAC с посолью тенанта', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 44), { ip: IP })
    const [app] = await admin`select ip_hash from vacancy_applications where vacancy_id = ${v.id}`
    expect(app!.ip_hash).not.toContain(IP)
    expect(app!.ip_hash).toBe(ipHash(tenantId, IP))
    // Посоль тенанта: тот же адрес в другом пространстве даёт другой хэш
    expect(ipHash(otherTenantId, IP)).not.toBe(app!.ip_hash)
  })
})

describe('подтверждение контакта и конверсия (критерии §13 к. 6, 7)', () => {
  it('к. 7 — подтверждённый отклик создаёт кандидата и ровно одну assignments по шаблону', async () => {
    const v = await newVacancy()
    const r = await submitApplication(v.token, humanBody(v.id, 51), { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.otpRequired).toBe(true)
    expect(r.devCode, 'в CI код возвращается вызывающему').toBeTruthy()

    const confirmed = await confirmApplication(v.token, r.applicationId, r.devCode!, { ip: IP })
    expect(confirmed).toEqual({ ok: true, status: 'accepted' })

    const [app] = await admin`select state, candidate_id, consent_given_at from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('accepted')
    expect(app!.candidate_id).toBeTruthy()

    const [person] = await admin`select * from users where id = ${app!.candidate_id}`
    expect(person!.kind).toBe('candidate')
    expect(person!.candidate_state).toBe('active')
    expect(person!.source).toBe('vacancy_link')
    expect(person!.vacancy_id).toBe(v.id)
    expect(person!.recruiter_id).toBe(recruiterId)
    expect(
      new Date(person!.consent_given_at as string).getTime(),
      'согласие обязано быть тем самым моментом из формы, иначе срок стирания ПД поедет',
    ).toBe(new Date(app!.consent_given_at as string).getTime())

    const assignments = await admin`
      select id, params, is_mandatory from assignments
       where tenant_id = ${tenantId} and ${`vacancy:${v.id}`} = any(tags)`
    expect(assignments.length, 'ровно одна assignments').toBe(1)
    expect(assignments[0]!.is_mandatory).toBe(true)
  })

  it('неверный код не подтверждает отклик и не создаёт кандидата', async () => {
    const v = await newVacancy()
    const r = await submitApplication(v.token, humanBody(v.id, 52), { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bad = await confirmApplication(v.token, r.applicationId, '000000', { ip: IP })
    expect(bad.ok).toBe(false)
    const [app] = await admin`select state, candidate_id, otp_confirmed_at from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('pending')
    expect(app!.candidate_id).toBeNull()
    expect(app!.otp_confirmed_at).toBeNull()
  })

  it('к. 6 — код не введён сутки: отклик expired, кандидата нет, ось candidates_active не тронута', async () => {
    const v = await newVacancy()
    const before = await measureLive(tenantId, 'candidates_active')
    const r = await submitApplication(v.token, humanBody(v.id, 53), { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await admin`update vacancy_applications set created_at = now() - interval '25 hours' where id = ${r.applicationId}`

    const n = await expireApplications(tenantId)
    expect(n).toBeGreaterThanOrEqual(1)
    const [app] = await admin`select state, candidate_id from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('expired')
    expect(app!.candidate_id).toBeNull()
    expect(await measureLive(tenantId, 'candidates_active')).toBe(before)
  })

  it('подтверждённый отклик задача истечения не трогает', async () => {
    const v = await newVacancy()
    const r = await submitApplication(v.token, humanBody(v.id, 54), { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await confirmApplication(v.token, r.applicationId, r.devCode!, { ip: IP })
    await admin`update vacancy_applications set created_at = now() - interval '25 hours' where id = ${r.applicationId}`
    await expireApplications(tenantId)
    const [app] = await admin`select state from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('accepted')
  })

  it('без OTP отклик становится кандидатом сразу', async () => {
    const v = await newVacancy({ publicApplyOtp: false })
    const r = await submitApplication(v.token, humanBody(v.id, 55), { ip: IP })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.otpRequired).toBe(false)
    const [app] = await admin`select state, candidate_id from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('accepted')
    expect(app!.candidate_id).toBeTruthy()
  })

  it('отклик уже работающего человека даёт merged, а не второй профиль (§12.6)', async () => {
    const v = await newVacancy({ publicApplyOtp: false })
    const [employee] = await admin`select phone from users where tenant_id = ${tenantId} and kind = 'employee' and phone is not null limit 1`
    const r = await submitApplication(v.token, humanBody(v.id, 56, { phone: employee!.phone }), { ip: IP })
    expect(r.ok, 'человеку на странице показан обычный текст благодарности').toBe(true)
    if (!r.ok) return
    const [app] = await admin`select state, candidate_id from vacancy_applications where id = ${r.applicationId}`
    expect(app!.state).toBe('merged')
    expect(app!.candidate_id).toBeTruthy()
    const twins = await admin`select id from users where phone = ${employee!.phone}`
    expect(twins.length, 'второго профиля быть не должно').toBe(1)
  })
})

describe('исчерпанная ось candidates_active (§12.2, условие выхода PR-16)', () => {
  it('отклик не теряется и не создаёт кандидата: pending_review с причиной limit', async () => {
    const used = await measureLive(tenantId, 'candidates_active')
    await admin`
      insert into tenant_limits (tenant_id, candidates) values (${tenantId}, ${used})
      on conflict (tenant_id) do update set candidates = ${used}`
    invalidateLimits(tenantId)
    try {
      const v = await newVacancy({ publicApplyOtp: false })
      const r = await submitApplication(v.token, humanBody(v.id, 61), { ip: IP })
      expect(r.ok, 'человеку показан обычный текст благодарности').toBe(true)
      if (!r.ok) return
      const [app] = await admin`select state, spam_reasons, candidate_id from vacancy_applications where id = ${r.applicationId}`
      expect(app!.state).toBe('pending_review')
      expect(app!.spam_reasons).toContain('limit')
      expect(app!.candidate_id).toBeNull()
      expect((await admin`select id from users where phone = ${phone(61)}`).length).toBe(0)
      expect(await measureLive(tenantId, 'candidates_active')).toBe(used)
    }
    finally {
      await admin`update tenant_limits set candidates = null where tenant_id = ${tenantId}`
      invalidateLimits(tenantId)
    }
  })
})

describe('кабинет рекрутера: разбор придержанных откликов (§7.7, §10)', () => {
  it('вкладка «На модерації» — это фильтр по состоянию', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 71, { website: 'x' }), { ip: IP })
    const held = await listApplications(ctx, v.id, { state: 'pending_review', limit: 50 })
    expect(held?.length).toBe(1)
    expect(held![0]!.spamReasons).toContain('honeypot')
  })

  it('принятый вручную отклик становится кандидатом — решение принимает человек', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 72, { website: 'x' }), { ip: IP })
    const [row] = await admin`select id from vacancy_applications where vacancy_id = ${v.id}`
    const r = await acceptApplication(ctx, v.id, row!.id as string)
    expect(r.ok).toBe(true)
    const [app] = await admin`select state, candidate_id, reviewed_by from vacancy_applications where id = ${row!.id}`
    expect(app!.state).toBe('accepted')
    expect(app!.candidate_id).toBeTruthy()
    expect(app!.reviewed_by).toBe(adminId)
  })

  it('отказ и «спам» пишут состояние, автора и запись в audit_log', async () => {
    const v = await newVacancy()
    await submitApplication(v.token, humanBody(v.id, 73), { ip: IP })
    const [one] = await admin`select id from vacancy_applications where vacancy_id = ${v.id}`
    expect((await rejectApplication(ctx, v.id, one!.id as string, 'Не підходить за графіком')).ok).toBe(true)
    const [after] = await admin`select state, reject_reason from vacancy_applications where id = ${one!.id}`
    expect(after!.state).toBe('rejected')
    expect(after!.reject_reason).toBe('Не підходить за графіком')

    const other = await newVacancy({ title: `${PREFIX}Бариста-е` })
    await submitApplication(other.token, humanBody(other.id, 74), { ip: '198.51.100.9' })
    const [two] = await admin`select id from vacancy_applications where vacancy_id = ${other.id}`
    expect((await markSpamApplication(ctx, other.id, two!.id as string)).ok).toBe(true)
    const [spam] = await admin`select state from vacancy_applications where id = ${two!.id}`
    expect(spam!.state).toBe('spam')

    const log = await admin`select action from audit_log where entity = 'vacancy_application' and entity_id = ${two!.id}`
    expect(log.map(r => r.action)).toContain('vacancy.application_spam')
  })

  it('чужая вакансия не существует: список откликов отдаёт «не знайдено», а не «заборонено»', async () => {
    const [foreign] = await admin`
      insert into vacancies (tenant_id, title, state) values (${otherTenantId}, ${`${PREFIX}Чужа-2`}, 'draft')
      returning id`
    expect(await listApplications(ctx, foreign!.id as string, { limit: 50 })).toBeNull()
    await admin`delete from vacancies where id = ${foreign!.id}`
  })
})

describe('уборка журнала попыток (§11)', () => {
  it('строки старше 30 дней уходят, свежие остаются', async () => {
    const v = await newVacancy()
    await publicVacancy(v.token, { ip: IP })
    await admin`
      insert into public_apply_attempts (tenant_id, vacancy_id, ip_hash, outcome, created_at)
      values (${tenantId}, ${v.id}, 'old', 'view', now() - interval '40 days')`
    const removed = await pruneApplyAttempts(tenantId)
    expect(removed).toBeGreaterThanOrEqual(1)
    const rows = await admin`select ip_hash from public_apply_attempts where vacancy_id = ${v.id}`
    expect(rows.map(r => r.ip_hash)).not.toContain('old')
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})
