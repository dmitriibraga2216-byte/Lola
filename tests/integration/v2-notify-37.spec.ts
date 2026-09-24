import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-37 пакета `docs/v2` (`45-plan.md`): коды уведомлений и вебхуки (патч П-23, решение В-18).
 *
 * Условия выхода:
 * - `WEBHOOK_EVENTS` = 10 значений (семь прежних + `candidate.hired`,
 *   `vacancy.application_received`, `offboarding.completed`);
 * - payload всех трёх новых событий — идентификаторы и время, без персональных данных
 *   (проверено тестом на реальных payload, не только на бумаге);
 * - тихие часы кандидата (09:00–20:00 по его локальному времени, докс/v2/42 §5 проверка 19) —
 *   не зависят от тумблера тенанта и берут таймзону точки вакансии, на которую откликнулся.
 *
 * `candidate.hired` и `offboarding.completed` шлются из реальных `hireCandidate()` /
 * `completeOffboarding()` — оба уже существуют в `main` (PR-14, PR-07). PR-16 (публичный
 * приём отклика) смержен в main **во время работы над этим PR** (#109, после `0e174c6`) —
 * рабочая ветка перебазирована на него, и `vacancy.application_received` подключён здесь же
 * к `convertApplication()` в `server/services/publicApply.ts`, реальным приёмом отклика
 * (`submitApplication()` без OTP — тот же путь, что критерий `29` §13 к. 7).
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createCandidate, viewerOf } = await import('../../server/services/candidates')
const { hireCandidate } = await import('../../server/services/candidateHire')
const { hire: hireEmployee, startOffboarding, completeOffboarding } = await import('../../server/services/offboarding')
const { createEndpoint, WEBHOOK_EVENTS } = await import('../../server/services/webhooks')
const {
  enqueueNotification, scheduleWithQuietHours, CANDIDATE_QUIET_HOURS, DEFAULT_TEMPLATES, renderTemplate,
} = await import('../../server/services/notifications')
const { updateQuietHours, readSettings } = await import('../../server/services/settings')
const { withTenant } = await import('../../server/utils/withTenant')
const { createVacancy, publishVacancy } = await import('../../server/services/vacancies')
const { submitApplication, signNonce } = await import('../../server/services/publicApply')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = '+38067993' // диапазон PR-37, отдельный от остальных спек пакета
const MARK = 'PR37'

let tenantId: string
let adminId: string
let locationId: string
let positionId: string
let ctx: { tenantId: string, actorId: string }
let hr: ReturnType<typeof viewerOf>
const seededUsers: string[] = []
const seededVacancies: string[] = []
const seededLocations: string[] = []
const seededEndpoints: string[] = []
let quietHoursBefore: Awaited<ReturnType<typeof readSettings>>['quietHours'] | null = null

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit', 'candidate.hire'], scopeType: 'tenant', scopeId: null }] })
  quietHoursBefore = (await withTenant(tenantId, adminId, tx => readSettings(tx, tenantId))).quietHours
}, 60_000)

afterAll(async () => {
  if (quietHoursBefore) await updateQuietHours(ctx, quietHoursBefore)
  for (const id of seededEndpoints) {
    await admin`delete from webhook_deliveries where endpoint_id = ${id}`
    await admin`delete from webhook_endpoints where id = ${id}`
  }
  for (const id of seededUsers) {
    await admin`delete from notifications where user_id = ${id}`
    await admin`delete from candidate_status_history where candidate_id = ${id}`
    await admin`delete from offboarding_cases where user_id = ${id}`
    await admin`delete from user_placements where user_id = ${id}`
    await admin`delete from employee_lifecycle_state where user_id = ${id}`
    await admin`delete from sessions where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
  for (const id of seededVacancies) await admin`delete from vacancies where id = ${id}`
  for (const id of seededLocations) await admin`delete from locations where id = ${id}`
  await admin.end()
})

describe('WEBHOOK_EVENTS: ровно 10 значений (докс/v2/44 В-18)', () => {
  it('семь прежних плюс ровно три новых, ни одного сверх', () => {
    expect(WEBHOOK_EVENTS).toHaveLength(10)
    expect([...WEBHOOK_EVENTS].sort()).toEqual([
      'assignment.overdue',
      'attempt.failed',
      'attempt.passed',
      'candidate.hired',
      'certificate.issued',
      'enrollment.completed',
      'notice.acknowledged',
      'offboarding.completed',
      'user.created',
      'vacancy.application_received',
    ])
  })
})

/** Ни ФІО, ні e-mail, ні телефону — во всём JSON доставки целиком, не только в объявленных ключах. */
function assertNoPii(payloadJson: string, pii: string[]) {
  for (const value of pii) expect(payloadJson.toLowerCase()).not.toContain(value.toLowerCase())
  expect(payloadJson).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i) // ни одного e-mail-подобного значения
  expect(payloadJson).not.toMatch(/\+\d{8,15}/) // ни одного телефона в формате E.164
}

describe('вебхук candidate.hired: реальный найм, payload без персональных данных', () => {
  let candidateId: string
  let endpointId: string
  const LAST_NAME = `${MARK}ВебхукНайм`
  const PHONE = `${PREFIX}0001`
  const EMAIL = 'pr37.candidate.webhook@example.test'

  beforeAll(async () => {
    const ep = await createEndpoint(ctx, { url: 'https://example.test/lola-webhook', events: [...WEBHOOK_EVENTS], description: `${MARK} test` })
    if (!ep.ok) throw new Error(`endpoint не создан: ${JSON.stringify(ep)}`)
    endpointId = ep.id
    seededEndpoints.push(endpointId)

    const created = await createCandidate(ctx, {
      firstName: MARK, lastName: LAST_NAME, phone: PHONE, email: EMAIL,
      consentGiven: true, confirmDuplicate: false, commLanguage: 'uk',
    })
    if (!created.ok) throw new Error(`кандидат не создан: ${JSON.stringify(created)}`)
    candidateId = created.candidate.id
    seededUsers.push(candidateId)
  })

  it('вебхук содержит только {userId, vacancyId, hiredAt} — ни ФІО, ні e-mail, ні телефону', async () => {
    const res = await hireCandidate(hr, candidateId, {
      locationId, positionId, startDate: '2026-10-01', onboardingCourseIds: [], welcomeLetter: false,
    })
    expect(res.ok, `найм не прошёл: ${JSON.stringify(res)}`).toBe(true)

    const [delivery] = await admin`
      select payload from webhook_deliveries
      where endpoint_id = ${endpointId} and event = 'candidate.hired'
      order by created_at desc limit 1`
    expect(delivery, 'нет доставки candidate.hired').toBeDefined()
    const payload = delivery!.payload as { event: string, tenantId: string, at: string, data: Record<string, unknown> }
    expect(payload.event).toBe('candidate.hired')
    expect(Object.keys(payload.data).sort()).toEqual(['hiredAt', 'userId', 'vacancyId'])
    expect(payload.data.userId).toBe(candidateId)
    expect(payload.data.hiredAt).toBe('2026-10-01')

    assertNoPii(JSON.stringify(payload), [LAST_NAME, MARK, PHONE, EMAIL])
  })
})

describe('вебхук offboarding.completed: реальное завершение офбординга, payload без персональных данных', () => {
  let employeeId: string
  let caseId: string
  let endpointId: string
  const FULL_NAME = `${MARK} ВебхукОфбординг`
  const PHONE = `${PREFIX}0002`

  beforeAll(async () => {
    const ep = await createEndpoint(ctx, { url: 'https://example.test/lola-webhook-2', events: [...WEBHOOK_EVENTS], description: `${MARK} test` })
    if (!ep.ok) throw new Error(`endpoint не создан: ${JSON.stringify(ep)}`)
    endpointId = ep.id
    seededEndpoints.push(endpointId)

    const hired = await hireEmployee(ctx, { phone: PHONE, fullName: FULL_NAME, locationId, positionId })
    if (typeof hired === 'string') throw new Error(`hire → ${hired}`)
    employeeId = hired.userId
    seededUsers.push(employeeId)

    const started = await startOffboarding(ctx, {
      userId: employeeId, reasonCode: 'own_wish', lastWorkingDay: new Date().toISOString().slice(0, 10),
      courseIds: [], responsibleId: adminId,
    })
    if (typeof started === 'string') throw new Error(`startOffboarding → ${started}`)
    caseId = started.id
  })

  it('вебхук содержит только {userId, caseId, completedAt} — ни ФІО, ні телефону', async () => {
    const res = await completeOffboarding(ctx, caseId)
    expect(typeof res, `завершение не прошло: ${JSON.stringify(res)}`).not.toBe('string')

    const [delivery] = await admin`
      select payload from webhook_deliveries
      where endpoint_id = ${endpointId} and event = 'offboarding.completed'
      order by created_at desc limit 1`
    expect(delivery, 'нет доставки offboarding.completed').toBeDefined()
    const payload = delivery!.payload as { event: string, tenantId: string, at: string, data: Record<string, unknown> }
    expect(payload.event).toBe('offboarding.completed')
    expect(Object.keys(payload.data).sort()).toEqual(['caseId', 'completedAt', 'userId'])
    expect(payload.data.userId).toBe(employeeId)
    expect(payload.data.caseId).toBe(caseId)

    assertNoPii(JSON.stringify(payload), [FULL_NAME, PHONE])
  })
})

describe('вебхук vacancy.application_received: реальный отклик по публичной ссылке (PR-16, смержен как #109)', () => {
  let endpointId: string
  let vacancyId: string
  let vacancyToken: string
  const APPLICANT_NAME = `${MARK} Відгук Вебхук`
  const APPLICANT_PHONE = `${PREFIX}0004`

  beforeAll(async () => {
    const ep = await createEndpoint(ctx, { url: 'https://example.test/lola-webhook-3', events: ['vacancy.application_received'], description: `${MARK} test` })
    if (!ep.ok) throw new Error(`endpoint не создан: ${JSON.stringify(ep)}`)
    endpointId = ep.id
    seededEndpoints.push(endpointId)

    const [course] = await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`
    const created = await createVacancy(ctx, {
      title: `${MARK} Вакансія Вебхук`,
      courseId: course!.id as string,
      locationId,
      recruiterId: adminId,
      salaryCurrency: 'UAH',
      salaryVisible: false,
      publicApplyOtp: false, // без OTP — тот же путь, что критерий `29` §13 к. 7, отклик становится кандидатом сразу
      applyDailyCap: 200,
      assignmentTemplate: { dueMode: 'relative', dueDays: 7, isMandatory: true, params: {}, reminders: {}, notifyOnAssign: true },
    } as Parameters<typeof createVacancy>[1])
    vacancyId = created.id
    seededVacancies.push(vacancyId)
    const hrVacancy = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish'], scopeType: 'tenant', scopeId: null }] })
    const published = await publishVacancy(hrVacancy, vacancyId)
    if (!published.ok) throw new Error(`вакансия не опубликовалась: ${JSON.stringify(published)}`)
    const [row] = await admin`select public_token from vacancies where id = ${vacancyId}`
    vacancyToken = row!.public_token as string
  })

  // Локально, а не в общем afterAll: assignFromVacancy() создаёт свою assignments+enrollment
  // на кандидата (§7.20), и они обязаны уйти раньше пользователя — FK не каскадный, как и
  // в tests/integration/v2-offboarding.spec.ts#cleanupPerson.
  afterAll(async () => {
    const rows = await admin`select id from assignments where title = ${`${MARK} Вакансія Вебхук`}`
    for (const a of rows) {
      await admin`delete from enrollment_events where enrollment_id in (select id from enrollments where assignment_id = ${a.id})`
      await admin`delete from enrollments where assignment_id = ${a.id}`
      await admin`delete from audit_log where entity = 'assignment' and entity_id = ${a.id}`
      await admin`delete from assignments where id = ${a.id}`
    }
  })

  it('приём отклика (submitApplication, без OTP) шлёт payload — только {vacancyId, applicationId, receivedAt}', async () => {
    const submitted = await submitApplication(vacancyToken, {
      fullName: APPLICANT_NAME,
      phone: APPLICANT_PHONE,
      consent: true,
      formNonce: signNonce(vacancyId, Date.now() - 10_000),
    } as Parameters<typeof submitApplication>[1], { ip: '203.0.113.55' })
    expect(submitted.ok, `отклик не принят: ${JSON.stringify(submitted)}`).toBe(true)
    if (!submitted.ok) return
    seededUsers.push((await admin`select candidate_id from vacancy_applications where id = ${submitted.applicationId}`)[0]!.candidate_id as string)

    const [delivery] = await admin`
      select payload from webhook_deliveries
      where endpoint_id = ${endpointId} and event = 'vacancy.application_received'
      order by created_at desc limit 1`
    expect(delivery, 'нет доставки vacancy.application_received').toBeDefined()
    const payload = delivery!.payload as { event: string, data: Record<string, unknown> }
    expect(Object.keys(payload.data).sort()).toEqual(['applicationId', 'receivedAt', 'vacancyId'])
    expect(payload.data.vacancyId).toBe(vacancyId)
    expect(payload.data.applicationId).toBe(submitted.applicationId)
    assertNoPii(JSON.stringify(payload), [APPLICANT_NAME, MARK, APPLICANT_PHONE])
  })
})

describe('тихие часы кандидата: своё окно 09:00–20:00 по таймзоне точки вакансии (докс/v2/42 §5 проверка 19)', () => {
  let farLocationId: string
  let vacancyId: string
  let candidateId: string
  const FAR_TZ = 'America/New_York' // далеко от Europe/Kyiv тенанта — расхождение видно на любом «сейчас»

  beforeAll(async () => {
    const [existing] = await admin`select org_unit_id from locations where id = ${locationId}`
    const [loc] = await admin`
      insert into locations (tenant_id, org_unit_id, name, timezone)
      values (${tenantId}, ${existing!.org_unit_id}, ${`${MARK} Точка США`}, ${FAR_TZ})
      returning id`
    farLocationId = loc!.id as string
    seededLocations.push(farLocationId)

    const [vac] = await admin`
      insert into vacancies (tenant_id, title, location_id) values (${tenantId}, ${`${MARK} Вакансія США`}, ${farLocationId})
      returning id`
    vacancyId = vac!.id as string
    seededVacancies.push(vacancyId)

    const created = await createCandidate(ctx, {
      firstName: MARK, lastName: `${MARK}ЧасКандидат`, phone: `${PREFIX}0003`,
      consentGiven: true, confirmDuplicate: false, commLanguage: 'uk', vacancyId,
    })
    if (!created.ok) throw new Error(`кандидат не создан: ${JSON.stringify(created)}`)
    candidateId = created.candidate.id
    seededUsers.push(candidateId)
  })

  /**
   * Оракул — та же чистая функция `scheduleWithQuietHours` с той же таймзоной точки вакансии,
   * вызванная непосредственно до и после `enqueueNotification()`: если механизм действительно
   * взял таймзону кандидата (а не тенанта — 7-часовая разница почти никогда не даёт того же
   * UTC-результата), результат ляжет в узкий коридор между двумя вызовами оракула.
   */
  async function expectScheduledByCandidateWindow(dedupKey: string) {
    const before = new Date()
    const ok = await withTenant(tenantId, adminId, tx => enqueueNotification(tx, {
      tenantId, userId: candidateId, code: 'candidate_reminder', payload: { vacancy: 'Test', days: 2 }, dedupKey,
    }))
    const after = new Date()
    expect(ok).toBe(true)

    const [row] = await admin`select scheduled_for from notifications where dedup_key = ${dedupKey}`
    expect(row, 'уведомление не найдено').toBeDefined()
    const got = new Date(row!.scheduled_for as string).getTime()

    const lo = scheduleWithQuietHours(before, FAR_TZ, CANDIDATE_QUIET_HOURS).getTime()
    const hi = scheduleWithQuietHours(after, FAR_TZ, CANDIDATE_QUIET_HOURS).getTime()
    const [min, max] = lo <= hi ? [lo, hi] : [hi, lo]
    expect(got).toBeGreaterThanOrEqual(min - 1000)
    expect(got).toBeLessThanOrEqual(max + 1000)
  }

  it('тумблер тенанта включён — кандидат всё равно расписан по своей таймзоне (не тенанта)', async () => {
    await updateQuietHours(ctx, { enabled: true, from: 9, to: 20 })
    await expectScheduledByCandidateWindow(`${MARK}:tz:enabled`)
  })

  it('тумблер тенанта выключен — на кандидата это не влияет (П-23: «вне тихих часов тенанта»)', async () => {
    await updateQuietHours(ctx, { enabled: false })
    await expectScheduledByCandidateWindow(`${MARK}:tz:disabled`)
  })
})

describe('новые коды уведомлений пакета зарегистрированы (докс/v2/41-api-delta.md §6)', () => {
  const NEW_CODES = [
    // 28-recruiting-candidates §8 — недостающие против PR-14
    'candidate_invited', 'candidate_reminder',
    // 29-vacancies §8 — недостающие против PR-16 (уже завёл vacancy_applied_welcome/vacancy_application_received)
    'vacancy_application_review', 'vacancy_spam_burst', 'vacancy_published_external',
    'vacancy_publication_failed', 'vacancy_account_revoked', 'vacancy_publication_expiring',
    'vacancy_closed_with_candidates', 'vacancy_subscriber_reopened',
    // 32-org-structure §8 — недостающие против PR-30 (уже завёл пять из семи)
    'org_structure_import_finished', 'org_structure_rollback',
    // 36-content-feedback §8 — PR-23 отложил уведомления на PR-24, регистрируем реестром
    'content_issue_created', 'content_issue_merged', 'content_issue_blocking', 'content_issue_overdue',
    'content_issue_accepted', 'content_issue_fixed', 'content_issue_rejected',
    'content_issue_rescore_ready', 'content_issue_rescored', 'content_reporter_muted',
  ]

  it('каждый код есть в DEFAULT_TEMPLATES и рендерится без исключений', () => {
    for (const code of NEW_CODES) {
      expect(DEFAULT_TEMPLATES[code], `код ${code} не зарегистрирован`).toBeTypeOf('string')
      expect(() => renderTemplate(DEFAULT_TEMPLATES[code]!, {
        vacancy: 'Тест', platform: 'Test', title: 'Тест', date: '2026-10-01', days: 3, n: 2,
        created: 1, updated: 1, errors: 0, label: 'X', count: 2, typeLabel: 'Тест', comment: '',
        scoreOld: 40, scoreNew: 80, points: 5, until: '2026-10-05', error: 'x', url: 'https://x',
      })).not.toThrow()
    }
  })

  it('лимит и лимит-дубликаты не заведены повторно (П-23: без дублирования limit_warning/limit_exceeded)', () => {
    expect(DEFAULT_TEMPLATES.candidate_limit_warning).toBeUndefined()
    expect(DEFAULT_TEMPLATES.vacancy_ai_quota).toBeUndefined()
    expect(DEFAULT_TEMPLATES.ai_ops_exhausted).toBeUndefined()
    expect(DEFAULT_TEMPLATES.limit_warning).toBeTypeOf('string')
    expect(DEFAULT_TEMPLATES.limit_exceeded).toBeTypeOf('string')
  })
})
