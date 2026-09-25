import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * PR-17 пакета `docs/v2` (`45-plan.md`): публикация и генерация текста
 * (`29-vacancies.md` §3.7–§3.10, §7.8–§7.18; решение `44` §8 — реальные аккаунты площадок
 * не заводятся, `vacancy_publications` получает статус `manual`).
 *
 * Критерии приёмки `29` §13, закреплённые за этим PR:
 * - **9** — блок, сгенерированный ИИ и не тронутый человеком, блокирует публикацию;
 * - **10** — исчерпанный `ai_generate_ops` даёт `limit_exceeded`, текст не сгенерирован,
 *   счётчик не изменился;
 * - **12** — отозванный токен площадки переводит аккаунт в `revoked`, секрет удаляется,
 *   публикация — в `conflict`, владелец и админ уведомлены, повторных обращений нет;
 * - **15** — публикация от компанейского аккаунта пишет `vacancy.published_external`
 *   в `audit_log` с `account_id`, `provider`, `payload_hash`, инициатором.
 *
 * Плюс задачи из постановки PR-17: резюме из публичного контура (отложено PR-16),
 * всплеск блокировок `vacancy.spam_watch` (§7.8), уведомление `vacancy_closed_with_candidates`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'
process.env.OTP_DEBUG = '1'

const { connectAccount, disconnectAccount, listAccounts, simulateProviderRevocation } = await import('../../server/services/jobBoardAccounts')
const { createPublications, listPublications } = await import('../../server/services/vacancyPublications')
const { generateVacancyText, generateVacancyCriteria, acknowledgeAiText } = await import('../../server/services/vacancyAi')
const { createVacancy, publishVacancy, updateVacancy, closeVacancy, viewerOf } = await import('../../server/services/vacancies')
const { createCandidate } = await import('../../server/services/candidates')
const { submitApplication, confirmApplication, signNonce, uploadApplicationResume } = await import('../../server/services/publicApply')
const { vacancyPublicationHealthTenant, vacancySpamWatchTenant } = await import('../../server/jobs/vacancyPublish')
const { currentUsage } = await import('../../server/services/usageCounters')
const { invalidateLimits } = await import('../../server/services/tenantLimits')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-17 '
const PHONE_BASE = '+38067993'
const IP = '203.0.113.17'

let tenantId: string
let adminId: string
let recruiterId: string
let courseId: string
let locationId: string
let ctx: { tenantId: string, actorId: string }
let hr: ReturnType<typeof viewerOf>
let hrAdminCtx: { tenantId: string, actorId: string, isAdmin: boolean }
let recruiterCtx: { tenantId: string, actorId: string, isAdmin: boolean }

function phone(n: number): string {
  return `${PHONE_BASE}${String(n).padStart(4, '0')}`
}

async function resetLimits() {
  await admin`delete from rate_limits where key like 'apply:%'`
}

async function cleanup() {
  await resetLimits()
  await admin`delete from vacancy_publications where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and key like 'jobboard:%'`
  await admin`delete from job_board_accounts where tenant_id = ${tenantId}`
  await admin`delete from vacancy_ai_generations where tenant_id = ${tenantId}`
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
  await admin`update tenant_limits set ai_generate_ops = null where tenant_id = ${tenantId}`
  // Счётчик `ai_generate_ops` копится в пределах биллингового периода и не знает про тесты:
  // без явного сброса повторный прогон файла видит уже потраченные операции из предыдущего
  // прогона и «исчерпанный лимит» проверяется на неверном исходном значении.
  await admin`delete from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  invalidateLimits(tenantId)
}

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

async function setAiLimit(n: number | null) {
  await admin`insert into tenant_limits (tenant_id, ai_generate_ops) values (${tenantId}, ${n})
    on conflict (tenant_id) do update set ai_generate_ops = ${n}`
  invalidateLimits(tenantId)
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish', 'vacancy.close', 'vacancy.ai.use', 'vacancy.criteria.manage'], scopeType: 'tenant', scopeId: null }] })
  hrAdminCtx = { tenantId, actorId: adminId, isAdmin: true }
  recruiterCtx = { tenantId, actorId: recruiterId, isAdmin: false }
  await cleanup()
})

/**
 * Каждый тест подключает свои аккаунты площадок с нуля: `uq_job_board_accounts_owner`
 * (тенант, площадка, тип владельца, владелец) допускает только один компанейский аккаунт
 * на площадку, и без очистки между тестами второй `connectAccount({provider:'work_ua',
 * ownerType:'company'})` в другом тесте падает на констрейнте.
 */
beforeEach(async () => {
  await admin`delete from vacancy_publications where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and key like 'jobboard:%'`
  await admin`delete from job_board_accounts where tenant_id = ${tenantId}`
  await admin`delete from usage_events where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
  await admin`delete from usage_counters where tenant_id = ${tenantId} and axis = 'ai_generate_ops'`
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

// ── Аккаунты площадок: права подключения (§7.14) ──────────────────────────────────────────

describe('job_board_accounts: права подключения (§7.14)', () => {
  it('компанейский аккаунт создаёт только админ', async () => {
    const asRecruiter = await connectAccount(recruiterCtx, { provider: 'work_ua', ownerType: 'company' })
    expect(asRecruiter.ok).toBe(false)
    if (!asRecruiter.ok) expect(asRecruiter.code).toBe('forbidden')

    const asAdmin = await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'company', label: `${PREFIX}company` })
    expect(asAdmin.ok).toBe(true)
    if (asAdmin.ok) {
      expect(asAdmin.account.status).toBe('active')
      const [secret] = await admin`select id from tenant_secrets where key = ${`jobboard:${asAdmin.account.id}`}`
      expect(secret, 'секрет заглушки должен быть создан').toBeDefined()
    }
  })

  it('персональный аккаунт всегда принадлежит тому, кто его создал — переданный ownerUserId игнорируется', async () => {
    const r = await connectAccount(recruiterCtx, { provider: 'robota_ua', ownerType: 'personal', ownerUserId: adminId })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.account.ownerUserId).toBe(recruiterId)
  })

  it('аккаунт рекрутера заводит только админ, и только на существующего сотрудника', async () => {
    const forbidden = await connectAccount(recruiterCtx, { provider: 'telegram', ownerType: 'recruiter', ownerUserId: recruiterId })
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) expect(forbidden.code).toBe('forbidden')

    const ok = await connectAccount(hrAdminCtx, { provider: 'telegram', ownerType: 'recruiter', ownerUserId: recruiterId, label: `${PREFIX}recruiter` })
    expect(ok.ok).toBe(true)
  })

  it('чужой личный аккаунт не виден рекрутеру без прав HR/админа', async () => {
    await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'company' })
    await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'personal', ownerUserId: adminId })
    const seenByAdmin = await listAccounts(hrAdminCtx)
    const seenByRecruiter = await listAccounts(recruiterCtx)
    expect(seenByAdmin.some(a => a.ownerUserId === adminId && a.ownerType === 'personal')).toBe(true)
    expect(seenByRecruiter.some(a => a.ownerUserId === adminId && a.ownerType === 'personal')).toBe(false)
    // Компанейские видны всем, кто держит скоуп доступа к списку (§5.4)
    expect(seenByRecruiter.some(a => a.ownerType === 'company')).toBe(true)
  })

  it('отключить личный аккаунт может только владелец — даже админу отказ (§7.14)', async () => {
    const created = await connectAccount(recruiterCtx, { provider: 'work_ua', ownerType: 'personal' })
    if (!created.ok) throw new Error('setup failed')

    const byAdmin = await disconnectAccount(hrAdminCtx, created.account.id)
    expect(byAdmin.ok).toBe(false)
    if (!byAdmin.ok) expect(byAdmin.code).toBe('forbidden')

    const bySelf = await disconnectAccount(recruiterCtx, created.account.id)
    expect(bySelf.ok).toBe(true)
  })

  it('аккаунт рекрутера отключает он сам или HR/админ (§7.14)', async () => {
    const created = await connectAccount(hrAdminCtx, { provider: 'telegram', ownerType: 'recruiter', ownerUserId: recruiterId })
    if (!created.ok) throw new Error('setup failed')
    const bySelf = await disconnectAccount(recruiterCtx, created.account.id)
    expect(bySelf.ok).toBe(true)
  })
})

// ── Публикации: адаптер, дубликат, вручную (§7.13, §7.17, критерий §13 к. 15) ─────────────

describe('vacancy_publications: адаптер и ручная запись (§7.13, `44` §8)', () => {
  it('публикация через компанейский аккаунт становится active и пишет audit_log (критерий §13 к. 15)', async () => {
    const acc = await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'company', label: `${PREFIX}pub-company` })
    if (!acc.ok) throw new Error('acc setup failed')
    const v = await newVacancy({ title: `${PREFIX}Публікація адаптером` })

    const r = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.account.id] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) {
      expect(r.publications[0]!.state).toBe('active')
      expect(r.publications[0]!.externalId).toBeTruthy()
    }

    const rows = await admin`select action, after from audit_log where entity = 'vacancy_publication' and action = 'vacancy.published_external' order by created_at desc limit 1`
    expect(rows.length).toBe(1)
    const after = rows[0]!.after as Record<string, unknown>
    expect(after.accountId).toBe(acc.account.id)
    expect(after.provider).toBe('work_ua')
    expect(after.payloadHash).toBeTruthy()
  })

  it('вторая публикация той же вакансии на тот же аккаунт — duplicate (§7.17)', async () => {
    const acc = await connectAccount(hrAdminCtx, { provider: 'robota_ua', ownerType: 'company', label: `${PREFIX}dup` })
    if (!acc.ok) throw new Error('acc setup failed')
    const v = await newVacancy({ title: `${PREFIX}Дублікат` })
    const first = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.account.id] })
    expect(first.ok).toBe(true)
    const second = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.account.id] })
    expect(second.ok).toBe(false)
    if (!second.ok && second.code === 'duplicate') expect(second.accountId).toBe(acc.account.id)
  })

  it('ручная публикация (`44` §8): без адаптера, готова сразу с посиланням', async () => {
    const acc = await connectAccount(hrAdminCtx, { provider: 'telegram', ownerType: 'company', label: `${PREFIX}manual-acc` })
    if (!acc.ok) throw new Error('acc setup failed')
    const v = await newVacancy({ title: `${PREFIX}Вручну` })
    const r = await createPublications(hr, { isAdmin: true }, v.id, {
      confirm: true, manual: { accountId: acc.account.id, externalUrl: 'https://t.me/example/1' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.publications[0]!.state).toBe('manual')
      expect(r.publications[0]!.externalUrl).toBe('https://t.me/example/1')
    }
    const list = await listPublications(hr, v.id)
    expect(list?.[0]?.state).toBe('manual')
  })
})

// ── Отзыв токена площадкой (§7.15, критерий §13 к. 12) ────────────────────────────────────

describe('отзыв токена площадкой (§7.15, критерий §13 к. 12)', () => {
  it('здоровье аккаунта обнаруживает отзыв: revoked, секрет удалён, публикация conflict, уведомление', async () => {
    const acc = await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'company', label: `${PREFIX}revoke` })
    if (!acc.ok) throw new Error('acc setup failed')
    const v = await newVacancy({ title: `${PREFIX}Відкликано` })
    const pub = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.account.id] })
    expect(pub.ok).toBe(true)

    await simulateProviderRevocation(tenantId, acc.account.id)
    await vacancyPublicationHealthTenant(tenantId)

    const [accRow] = await admin`select status, secret_ref from job_board_accounts where id = ${acc.account.id}`
    expect(accRow!.status).toBe('revoked')
    expect(accRow!.secret_ref).toBeNull()

    const [secretRow] = await admin`select id from tenant_secrets where key = ${`jobboard:${acc.account.id}`}`
    expect(secretRow, 'секрет должен быть физически удалён').toBeUndefined()

    const list = await listPublications(hr, v.id)
    expect(list?.[0]?.state).toBe('conflict')

    const notes = await admin`select id, user_id from notifications where tenant_id = ${tenantId} and code = 'vacancy_account_revoked'`
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.some(n => n.user_id === adminId)).toBe(true)

    // Повторный скан не должен ничего сломать и не трогает уже отозванный аккаунт (idempotent).
    await vacancyPublicationHealthTenant(tenantId)
    const notesAfter = await admin`select id from notifications where tenant_id = ${tenantId} and code = 'vacancy_account_revoked'`
    expect(notesAfter.length).toBe(notes.length)
  })
})

// ── ИИ-генерация: лимит ai_generate_ops (§7.10, критерий §13 к. 10) ───────────────────────

describe('генерация текста: лимит ai_generate_ops (§7.10, критерий §13 к. 10)', () => {
  it('одна генерация = одна операция; исчерпанный лимит не списывает и не пишет текст', async () => {
    await setAiLimit(1)
    const v = await newVacancy({ title: `${PREFIX}ІІ-текст`, descriptionHtml: null })
    const before = await currentUsage(tenantId, 'ai_generate_ops')

    const r1 = await generateVacancyText(hr, v.id, { target: 'description', tone: null })
    expect(r1.ok).toBe(true)
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before + 1)
    if (r1.ok) {
      expect(r1.html.length).toBeGreaterThan(0)
      const [row] = await admin`select ai_blocks, description_html from vacancies where id = ${v.id}`
      expect((row!.ai_blocks as Record<string, unknown>).description).toBeDefined()
      expect(row!.description_html).toBe(r1.html)
    }

    const usedNow = await currentUsage(tenantId, 'ai_generate_ops')
    const r2 = await generateVacancyText(hr, v.id, { target: 'requirements', tone: null })
    expect(r2.ok).toBe(false)
    if (!r2.ok && r2.code === 'limit_exceeded') expect(r2.check.axis).toBe('ai_generate_ops')
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(usedNow)
    const [row2] = await admin`select requirements_html from vacancies where id = ${v.id}`
    expect(row2!.requirements_html).toBeNull()
  })

  it('черновик критериев тоже стоит операцию и не пишет строки без явного сохранения (§7.11)', async () => {
    await setAiLimit(5)
    const v = await newVacancy({ title: `${PREFIX}Критерії-ІІ` })
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    const r = await generateVacancyCriteria(hr, v.id)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.criteria.length).toBeGreaterThanOrEqual(3)
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before + 1)
    const rows = await admin`select id from vacancy_criteria where vacancy_id = ${v.id}`
    expect(rows.length).toBe(0)
  })
})

// ── Публикация блокируется неперевіреним ІІ-текстом (§7.9, критерий §13 к. 9) ────────────

describe('публикация и непроверенный ИИ-текст (§7.9, критерий §13 к. 9)', () => {
  it('блок без правки и без подтверждения блокирует публикацию; подтверждение снимает блок', async () => {
    await setAiLimit(5)
    const created = await createVacancy(ctx, {
      title: `${PREFIX}Блок ІІ`, courseId, locationId, recruiterId,
      salaryCurrency: 'UAH', salaryVisible: false, publicApplyOtp: true, applyDailyCap: 200,
    } as Parameters<typeof createVacancy>[1])
    const gen = await generateVacancyText(hr, created.id, { target: 'description', tone: null })
    expect(gen.ok).toBe(true)
    if (!gen.ok) return

    const blocked = await publishVacancy(hr, created.id)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok && blocked.code === 'ai_text_unreviewed') expect(blocked.blocks).toContain('description')

    const ack = await acknowledgeAiText(hr, created.id, gen.generationId)
    expect(ack.ok).toBe(true)
    const published = await publishVacancy(hr, created.id)
    expect(published.ok, JSON.stringify(published)).toBe(true)
  })

  it('правка блоку людиною знімає позначку без кнопки «Текст перевірено» (§3.6)', async () => {
    await setAiLimit(5)
    const created = await createVacancy(ctx, {
      title: `${PREFIX}Правка ІІ`, courseId, locationId, recruiterId,
      salaryCurrency: 'UAH', salaryVisible: false, publicApplyOtp: true, applyDailyCap: 200,
    } as Parameters<typeof createVacancy>[1])
    const gen = await generateVacancyText(hr, created.id, { target: 'requirements', tone: null })
    expect(gen.ok).toBe(true)

    const edited = await updateVacancy(hr, created.id, { requirementsHtml: 'Написано людиною після генерації' })
    expect(edited.ok).toBe(true)
    if (edited.ok) {
      const block = (edited.vacancy.aiBlocks as Record<string, { editedAt?: string | null } | undefined>).requirements
      expect(block?.editedAt).toBeTruthy()
    }

    const published = await publishVacancy(hr, created.id)
    expect(published.ok, JSON.stringify(published)).toBe(true)
  })
})

// ── Закрытие с кандидатами в работе: уведомление (§8) ──────────────────────────────────────

describe('vacancy_closed_with_candidates (§8)', () => {
  it('закрытие с кандидатом в работе шлёт уведомление рекрутеру и админу', async () => {
    const v = await newVacancy({ title: `${PREFIX}Закриття з кандидатом` })
    const cand = await createCandidate(ctx, {
      firstName: 'Кандидат', lastName: 'Закриття', phone: phone(90),
      commLanguage: 'uk', consentGiven: true, confirmDuplicate: false, vacancyId: v.id,
    } as never)
    expect(cand.ok).toBe(true)

    const closed = await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: true, notifyCandidates: false })
    expect(closed.ok).toBe(true)
    if (closed.ok) expect(closed.candidates?.length).toBe(1)

    const notes = await admin`select user_id from notifications where tenant_id = ${tenantId} and code = 'vacancy_closed_with_candidates'`
    expect(notes.some(n => n.user_id === recruiterId)).toBe(true)
    expect(notes.some(n => n.user_id === adminId)).toBe(true)
  })

  it('закрытие с removeExternal снимает активные публикации (§4 «в очередь на снятие»)', async () => {
    const acc = await connectAccount(hrAdminCtx, { provider: 'work_ua', ownerType: 'company', label: `${PREFIX}close` })
    if (!acc.ok) throw new Error('acc setup failed')
    const v = await newVacancy({ title: `${PREFIX}Закриття знімає публікації` })
    const pub = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.account.id] })
    if (!pub.ok) throw new Error('pub setup failed')
    expect(pub.publications[0]!.state).toBe('active')

    await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: true, notifyCandidates: false })
    const [row] = await admin`select state from vacancy_publications where id = ${pub.publications[0]!.id}`
    expect(row!.state).toBe('removed')
  })
})

// ── Резюме из публичного контура (§6.3, §12.7, отложено PR-16) ────────────────────────────

describe('резюме из публичного контура: до подтверждения — нельзя (§6.3, план PR-17)', () => {
  it('до подтверждения контакта — state_locked; после — файл принят и привязан', async () => {
    const v = await newVacancy({ title: `${PREFIX}Резюме` })
    const sub = await submitApplication(v.token, {
      fullName: 'Різдвяна Заявниця', phone: phone(91), consent: true, formNonce: signNonce(v.id, Date.now() - 10_000),
    } as Parameters<typeof submitApplication>[1], { ip: IP })
    expect(sub.ok).toBe(true)
    if (!sub.ok) return

    const pdf = { filename: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 fake resume content') }
    const early = await uploadApplicationResume(v.token, sub.applicationId, pdf)
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.code).toBe('state_locked')

    const confirmed = await confirmApplication(v.token, sub.applicationId, sub.devCode!, { ip: IP })
    expect(confirmed.ok).toBe(true)

    const bad = await uploadApplicationResume(v.token, sub.applicationId, { filename: 'cv.zip', mime: 'application/zip', data: Buffer.from('x') })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('mime_not_allowed')

    const ok = await uploadApplicationResume(v.token, sub.applicationId, pdf)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      const [app] = await admin`select resume_asset_id from vacancy_applications where id = ${sub.applicationId}`
      expect(app!.resume_asset_id).toBe(ok.assetId)
      const [media] = await admin`select origin, owner_user_id from media_assets where id = ${ok.assetId}`
      expect(media!.origin).toBe('candidate_cv')
      expect(media!.owner_user_id).toBeNull()
    }
  })
})

// ── Всплеск блокировок: vacancy.spam_watch (§7.8) ──────────────────────────────────────────

describe('vacancy.spam_watch: всплеск блокировок удваивает лимиты на 6 часов (§7.8)', () => {
  it('20+ блокировок за час хардненят вакансию и шлют vacancy_spam_burst', async () => {
    const v = await newVacancy({ title: `${PREFIX}Спалах спаму` })
    for (let i = 0; i < 21; i++) {
      await admin`insert into public_apply_attempts (tenant_id, vacancy_id, ip_hash, outcome, reason)
        values (${tenantId}, ${v.id}, ${`hash-${i}`}, 'submit_blocked', 'ip_hour')`
    }
    const hardened = await vacancySpamWatchTenant(tenantId)
    expect(hardened).toBeGreaterThan(0)

    const [row] = await admin`select spam_hardened_until from vacancies where id = ${v.id}`
    expect(row!.spam_hardened_until).not.toBeNull()
    expect(new Date(row!.spam_hardened_until as string).getTime()).toBeGreaterThan(Date.now())

    const notes = await admin`select id from notifications where tenant_id = ${tenantId} and code = 'vacancy_spam_burst'`
    expect(notes.length).toBeGreaterThan(0)
  })

  it('под хардненингом второй отклик с того же адреса блокируется вместо третьего (лимит вдвое ниже)', async () => {
    const v = await newVacancy({ title: `${PREFIX}Хардненинг лімітів` })
    await admin`update vacancies set spam_hardened_until = now() + interval '6 hours' where id = ${v.id}`
    await resetLimits()

    const first = await submitApplication(v.token, {
      fullName: 'Перший Відвідувач', phone: phone(92), consent: true, formNonce: signNonce(v.id, Date.now() - 10_000),
    } as Parameters<typeof submitApplication>[1], { ip: '203.0.113.55' })
    expect(first.ok).toBe(true)

    const second = await submitApplication(v.token, {
      fullName: 'Другий Відвідувач', phone: phone(93), consent: true, formNonce: signNonce(v.id, Date.now() - 10_000),
    } as Parameters<typeof submitApplication>[1], { ip: '203.0.113.55' })
    // Ответ формы всегда одинаков (§7.3) — про блокировку узнаём из журнала попыток.
    expect(second.ok).toBe(true)
    const blocked = await admin`select reason from public_apply_attempts where vacancy_id = ${v.id} and ip_hash is not null and reason = 'ip_hour' order by created_at desc limit 1`
    expect(blocked.length).toBe(1)
  })
})
