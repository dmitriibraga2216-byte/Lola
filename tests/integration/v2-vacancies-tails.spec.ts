import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * vacancies-tails — хвосты блока «Вакансии» (`docs/v2/29-vacancies.md`; решения `v2/44` §20
 * Р-VT.1…Р-VT.5; миграция `0104_v2_vacancy_tails`):
 *
 * - `vacancy.remove_external` (§4, §11): закрытие ставит снятие в очередь, задача зовёт
 *   `remove()` адаптера, молчащая площадка — повтор, отозванный токен — `conflict` на виду;
 * - статус площадки `failing` (`docs/09` §9.3 «Мовчить») и «Спробувати ще раз» (§5.4);
 * - `vacancy.publication_expiry` (§11, §8): `expired` и `vacancy_publication_expiring` за 3 дня;
 * - подписка на странице 410 и `vacancy.subscriber_notify` (§5.6, §10, §11);
 * - `vacancy.stats_rollup` (§11): свёртка публичной страницы переживает уборку журнала;
 * - «контакт в чёрном списке тенанта» (§7.7): +100, отклик молча уходит в `spam`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'
process.env.OTP_DEBUG = '1'

const { connectAccount, simulateProviderOutage, simulateProviderRecovery, simulateProviderRevocation } = await import('../../server/services/jobBoardAccounts')
const { createPublications, publicationExpiryScan, recheckAccount, removePublication } = await import('../../server/services/vacancyPublications')
const { createVacancy, publishVacancy, pauseVacancy, closeVacancy, viewerOf } = await import('../../server/services/vacancies')
const { submitApplication, signNonce } = await import('../../server/services/publicApply')
const { subscribeToVacancy, notifyVacancySubscribers } = await import('../../server/services/vacancySubscribers')
const { addToBlocklist, blocklistApplication, listBlocklist, removeFromBlocklist, isContactBlocked } = await import('../../server/services/contactBlocklist')
const { vacancyPublicationHealthTenant, vacancyRemoveExternalJob, vacancyStatsRollupJob } = await import('../../server/jobs/vacancyPublish')
const Secrets = await import('../../server/services/secrets')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-vt '
const PHONE_BASE = '+38067994'
const MAILPIT = 'http://localhost:8025'

let tenantId: string
let adminId: string
let recruiterId: string
let courseId: string
let locationId: string
let ctx: { tenantId: string, actorId: string }
let hr: ReturnType<typeof viewerOf>
let hrAdminCtx: { tenantId: string, actorId: string, isAdmin: boolean }

function phone(n: number): string {
  return `${PHONE_BASE}${String(n).padStart(4, '0')}`
}

async function cleanup() {
  await admin`delete from rate_limits where key like 'apply:%'`
  await admin`delete from vacancy_publications where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and key like 'jobboard:%'`
  await admin`delete from job_board_accounts where tenant_id = ${tenantId}`
  await admin`delete from contact_blocklist where tenant_id = ${tenantId}`
  const vs = await admin`select id from vacancies where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`delete from public_apply_attempts where vacancy_id = ${v.id}`
    await admin`delete from vacancy_applications where vacancy_id = ${v.id}`
    await admin`update users set vacancy_id = null where vacancy_id = ${v.id}`
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  const people = await admin`select id from users where phone like ${`${PHONE_BASE}%`}`
  for (const p of people) {
    await admin`delete from candidate_status_history where candidate_id = ${p.id}`
    await admin`delete from enrollments where user_id = ${p.id}`
    await admin`delete from notifications where user_id = ${p.id}`
    await admin`delete from users where id = ${p.id}`
  }
  await admin`delete from assignments where title like ${`${PREFIX}%`}`
  await admin`delete from otp_codes where phone like ${`${PHONE_BASE}%`}`
  await admin`delete from user_roles where role_id in (select id from roles where tenant_id = ${tenantId} and code = 'v2-vt-jb')`
  await admin`delete from roles where tenant_id = ${tenantId} and code = 'v2-vt-jb'`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'vacancy_%'`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (action like 'contact_blocklist.%' or action like 'jobboard.account_%')`
}

async function newVacancy(title: string, over: Record<string, unknown> = {}): Promise<{ id: string, token: string }> {
  const created = await createVacancy(ctx, {
    title: `${PREFIX}${title}`,
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

async function companyAccount(provider: 'work_ua' | 'robota_ua' | 'telegram' = 'work_ua') {
  const acc = await connectAccount(hrAdminCtx, { provider, ownerType: 'company', label: `${PREFIX}${provider}` })
  if (!acc.ok) throw new Error(`account setup failed: ${JSON.stringify(acc)}`)
  return acc.account
}

async function publishTo(vacancyId: string, accountId: string): Promise<string> {
  const r = await createPublications(hr, { isAdmin: true }, vacancyId, { confirm: true, accountIds: [accountId] })
  if (!r.ok) throw new Error(`publication setup failed: ${JSON.stringify(r)}`)
  return r.publications[0]!.id
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish', 'vacancy.close'], scopeType: 'tenant', scopeId: null }] })
  hrAdminCtx = { tenantId, actorId: adminId, isAdmin: true }
  await cleanup()
})

beforeEach(async () => {
  await admin`delete from vacancy_publications where tenant_id = ${tenantId}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and key like 'jobboard:%'`
  await admin`delete from job_board_accounts where tenant_id = ${tenantId}`
})

afterAll(async () => {
  await cleanup()
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'smtp'`
  await admin.end()
})

// ── vacancy.remove_external (§4, §11) ─────────────────────────────────────────────────────

describe('vacancy.remove_external: снятие с площадок после закрытия', () => {
  it('закрытие не снимает синхронно; задача снимает адаптером, ручную строку — без него', async () => {
    const acc = await companyAccount('work_ua')
    const manualAcc = await companyAccount('robota_ua')
    const v = await newVacancy('Зняття задачею')
    const pubId = await publishTo(v.id, acc.id)
    const manual = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, manual: { accountId: manualAcc.id, externalUrl: 'https://robota-ua.example/v/1' } })
    expect(manual.ok).toBe(true)

    const closed = await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: true, notifyCandidates: false })
    expect(closed.ok).toBe(true)
    expect((await admin`select state from vacancy_publications where id = ${pubId}`)[0]!.state).toBe('active')

    const r = await vacancyRemoveExternalJob(tenantId, v.id)
    expect(r).toEqual({ removed: 2, pending: 0 })
    const rows = await admin`select state, removed_at from vacancy_publications where vacancy_id = ${v.id}`
    expect(rows.every(x => x.state === 'removed' && x.removed_at)).toBe(true)
    const audit = await admin`select after from audit_log where entity_id = ${pubId} and action = 'vacancy.unpublished_external'`
    expect((audit[0]!.after as { viaAdapter: boolean }).viaAdapter).toBe(true)

    // Повтор задачи ничего не трогает: снятые строки второй раз не снимаются.
    expect(await vacancyRemoveExternalJob(tenantId, v.id)).toEqual({ removed: 0, pending: 0 })
  })

  it('молчащая площадка — задача падает для повтора, строка остаётся active с ошибкой; после ответа снимается', async () => {
    const acc = await companyAccount()
    const v = await newVacancy('Зняття мовчить')
    const pubId = await publishTo(v.id, acc.id)
    await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: true, notifyCandidates: false })
    await simulateProviderOutage(tenantId, acc.id)

    await expect(vacancyRemoveExternalJob(tenantId, v.id)).rejects.toThrow(/не ответила|не відповіла|площадка/)
    const [row] = await admin`select state, last_error_code from vacancy_publications where id = ${pubId}`
    expect(row!.state).toBe('active')
    expect(row!.last_error_code).toBe('jobboard.remove_failed')

    await simulateProviderRecovery(tenantId, acc.id)
    expect(await vacancyRemoveExternalJob(tenantId, v.id)).toEqual({ removed: 1, pending: 0 })
    expect((await admin`select state, last_error_code from vacancy_publications where id = ${pubId}`)[0]).toMatchObject({ state: 'removed', last_error_code: null })
  })

  it('отозванный токен — объявление не притворяется снятым: conflict на виду', async () => {
    const acc = await companyAccount()
    const v = await newVacancy('Зняття відкликано')
    const pubId = await publishTo(v.id, acc.id)
    await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: true, notifyCandidates: false })
    await simulateProviderRevocation(tenantId, acc.id)

    expect(await vacancyRemoveExternalJob(tenantId, v.id)).toEqual({ removed: 0, pending: 0 })
    expect((await admin`select state from vacancy_publications where id = ${pubId}`)[0]!.state).toBe('conflict')
    expect((await admin`select status from job_board_accounts where id = ${acc.id}`)[0]!.status).toBe('revoked')
  })

  it('DELETE одной публикации идёт через адаптер; площадка молчит — remote_failed', async () => {
    const acc = await companyAccount()
    const v = await newVacancy('Зняти одну')
    const pubId = await publishTo(v.id, acc.id)
    await simulateProviderOutage(tenantId, acc.id)
    expect(await removePublication(hr, v.id, pubId)).toEqual({ ok: false, code: 'remote_failed' })
    expect((await admin`select state from vacancy_publications where id = ${pubId}`)[0]!.state).toBe('active')

    await simulateProviderRecovery(tenantId, acc.id)
    expect(await removePublication(hr, v.id, pubId)).toEqual({ ok: true })
    expect(await removePublication(hr, v.id, pubId)).toEqual({ ok: false, code: 'not_active' })
  })
})

// ── Статус failing (docs/09 §9.3, `29` §5.4, §11) ─────────────────────────────────────────

describe('площадка молчит: failing и «Спробувати ще раз»', () => {
  it('health без отзыва переводит в failing с ошибкой и журналом; ответ — снова active', async () => {
    const acc = await companyAccount()
    await vacancyPublicationHealthTenant(tenantId)
    const [ok] = await admin`select status, last_ok_at from job_board_accounts where id = ${acc.id}`
    expect(ok!.status).toBe('active')
    expect(ok!.last_ok_at).toBeTruthy()

    await simulateProviderOutage(tenantId, acc.id)
    await vacancyPublicationHealthTenant(tenantId)
    const [bad] = await admin`select status, last_error, last_ok_at from job_board_accounts where id = ${acc.id}`
    expect(bad!.status).toBe('failing')
    expect(bad!.last_error).toBe('jobboard.no_response')
    expect(bad!.last_ok_at).toEqual(ok!.last_ok_at) // «не відповідає з …» — від останнього успіху
    expect((await admin`select 1 from audit_log where entity_id = ${acc.id} and action = 'jobboard.account_failing'`).length).toBe(1)

    // Новая публикация в молчащий аккаунт не создаётся (§6.1 «статус active»).
    const v = await newVacancy('Мовчить публікація')
    const pub = await createPublications(hr, { isAdmin: true }, v.id, { confirm: true, accountIds: [acc.id] })
    expect(pub).toMatchObject({ ok: false, code: 'account_not_active' })

    // Повторный проход не пишет второй строки журнала.
    await vacancyPublicationHealthTenant(tenantId)
    expect((await admin`select 1 from audit_log where entity_id = ${acc.id} and action = 'jobboard.account_failing'`).length).toBe(1)

    await simulateProviderRecovery(tenantId, acc.id)
    expect(await recheckAccount(hrAdminCtx, acc.id)).toEqual({ ok: true, outcome: 'ok' })
    const [back] = await admin`select status, last_error from job_board_accounts where id = ${acc.id}`
    expect(back).toMatchObject({ status: 'active', last_error: null })
    expect((await admin`select 1 from audit_log where entity_id = ${acc.id} and action = 'jobboard.account_recovered'`).length).toBe(1)
  })

  it('переход в failing — одно уведомление на эпизод носителям jobboard.connect, со ссылкой на «Інтеграції» (44 Р-VT.5)', async () => {
    // Рекрутер с jobboard.connect — через кастомную роль; без скоупа уведомление не получает никто, кроме админов.
    const [role] = await admin`insert into roles (tenant_id, code, name, scopes) values (${tenantId}, 'v2-vt-jb', 'v2-vt jobboard', array['jobboard.connect']::text[]) returning id`
    await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${tenantId}, ${recruiterId}, ${role!.id}, 'tenant')`
    try {
      const acc = await companyAccount('robota_ua')
      const notes = () => admin`select user_id, payload, dedup_key from notifications where tenant_id = ${tenantId} and code = 'vacancy_account_failing' and ref_id = ${acc.id}`

      await simulateProviderOutage(tenantId, acc.id)
      await vacancyPublicationHealthTenant(tenantId)
      const first = await notes()
      const users = first.map(n => n.user_id as string)
      expect(users).toContain(recruiterId)
      expect(users).toContain(adminId)
      expect(new Set(users).size).toBe(users.length)
      expect(first[0]!.payload).toMatchObject({ platform: 'robota_ua', url: '/admin/vacancies?tab=integrations' })

      // Пока площадка молчит — без повторов: ни фоновый проход, ни «Спробувати ще раз».
      await vacancyPublicationHealthTenant(tenantId)
      expect(await recheckAccount(hrAdminCtx, acc.id)).toEqual({ ok: true, outcome: 'failing' })
      expect((await notes()).length).toBe(first.length)

      // Вернулась и снова замолчала — новый эпизод, новое уведомление.
      await simulateProviderRecovery(tenantId, acc.id)
      await vacancyPublicationHealthTenant(tenantId)
      await simulateProviderOutage(tenantId, acc.id)
      await vacancyPublicationHealthTenant(tenantId)
      expect((await notes()).length).toBe(first.length * 2)

      // Личный аккаунт админа рекрутер не видит (§7.14) — и уведомления о нём не получает.
      const personal = await connectAccount(hrAdminCtx, { provider: 'telegram', ownerType: 'personal', label: `${PREFIX}personal-failing` })
      if (!personal.ok) throw new Error('personal setup failed')
      await simulateProviderOutage(tenantId, personal.account.id)
      await vacancyPublicationHealthTenant(tenantId)
      const own = await admin`select user_id from notifications where code = 'vacancy_account_failing' and ref_id = ${personal.account.id}`
      expect(own.map(n => n.user_id)).toContain(adminId)
      expect(own.map(n => n.user_id)).not.toContain(recruiterId)
    }
    finally {
      await admin`delete from user_roles where role_id = ${role!.id}`
      await admin`delete from roles where id = ${role!.id}`
    }
  })

  it('«Спробувати ще раз» по чужому личному аккаунту — not_found (§7.14)', async () => {
    const personal = await connectAccount({ tenantId, actorId: adminId, isAdmin: true }, { provider: 'telegram', ownerType: 'personal', label: `${PREFIX}personal` })
    if (!personal.ok) throw new Error('personal setup failed')
    expect(await recheckAccount({ tenantId, actorId: recruiterId, isAdmin: false }, personal.account.id)).toEqual({ ok: false, code: 'not_found' })
    expect(await recheckAccount({ tenantId, actorId: adminId, isAdmin: false }, personal.account.id)).toMatchObject({ ok: true })
  })
})

// ── vacancy.publication_expiry (§11, §8) ─────────────────────────────────────────────────

describe('vacancy.publication_expiry: срок объявления', () => {
  it('истёкшее → expired с журналом; истекающее за 3 дня — одно уведомление рекрутеру в колокольчик', async () => {
    const acc = await companyAccount('work_ua')
    const acc2 = await companyAccount('robota_ua')
    const acc3 = await companyAccount('telegram')
    const v = await newVacancy('Строк оголошення')
    const past = await publishTo(v.id, acc.id)
    const soon = await publishTo(v.id, acc2.id)
    const later = await publishTo(v.id, acc3.id)
    await admin`update vacancy_publications set expires_at = now() - interval '1 hour' where id = ${past}`
    await admin`update vacancy_publications set expires_at = now() + interval '2 days' where id = ${soon}`
    await admin`update vacancy_publications set expires_at = now() + interval '5 days' where id = ${later}`

    expect(await publicationExpiryScan(tenantId)).toEqual({ expired: 1, warned: 1 })
    expect((await admin`select state from vacancy_publications where id = ${past}`)[0]!.state).toBe('expired')
    expect((await admin`select 1 from audit_log where entity_id = ${past} and action = 'vacancy.publication_expired'`).length).toBe(1)
    const notes = await admin`select user_id, channel, payload from notifications where tenant_id = ${tenantId} and code = 'vacancy_publication_expiring'`
    expect(notes.length).toBe(1)
    expect(notes[0]!.user_id).toBe(recruiterId)
    expect(notes[0]!.channel).toBe('inapp')
    expect((notes[0]!.payload as { platform: string }).platform).toBe('robota_ua')

    // Повторный прогон того же дня — без второго уведомления; продление срока — предупредит заново.
    expect(await publicationExpiryScan(tenantId)).toEqual({ expired: 0, warned: 0 })
    await admin`update vacancy_publications set expires_at = now() + interval '1 day' where id = ${soon}`
    expect(await publicationExpiryScan(tenantId)).toEqual({ expired: 0, warned: 1 })
  })
})

// ── Подписка на странице 410 и vacancy.subscriber_notify (§5.6, §10, §11) ───────────────

describe('подписка «Повідомити, коли відкриється»', () => {
  const ip = '198.51.100.40'

  it('на паузе адрес хранится один раз без учёта регистра; у открытой — 202 без записи; закрытая и чужая — 404', async () => {
    const v = await newVacancy('Підписка')
    expect(await subscribeToVacancy(v.token, 'Olena@Example.test', { ip })).toEqual({ ok: true })
    expect((await admin`select count(*)::int as n from vacancy_subscribers where vacancy_id = ${v.id}`)[0]!.n).toBe(0)

    await pauseVacancy(hr, v.id)
    expect(await subscribeToVacancy(v.token, 'Olena@Example.test', { ip })).toEqual({ ok: true })
    expect(await subscribeToVacancy(v.token, 'olena@example.test', { ip })).toEqual({ ok: true })
    const subs = await admin`select email, locale from vacancy_subscribers where vacancy_id = ${v.id}`
    expect(subs.length).toBe(1)
    expect(subs[0]!.locale).toBeTruthy()

    expect(await subscribeToVacancy('NoSuchToken0000000000A', 'x@example.test', { ip })).toEqual({ ok: false, code: 'not_found' })

    // Закрытие удаляет подписку без письма, ссылка умирает (Р-VT.2).
    await closeVacancy(hr, v.id, { reason: 'filled', removeExternal: false, notifyCandidates: false })
    expect((await admin`select count(*)::int as n from vacancy_subscribers where vacancy_id = ${v.id}`)[0]!.n).toBe(0)
    expect(await subscribeToVacancy(v.token, 'y@example.test', { ip })).toEqual({ ok: false, code: 'not_found' })
  })

  it('частота: пятый адрес в час проходит, шестой — rate_limited', async () => {
    const v = await newVacancy('Підписка частота')
    await pauseVacancy(hr, v.id)
    const burstIp = '198.51.100.41'
    for (let i = 0; i < 5; i++) expect(await subscribeToVacancy(v.token, `p${i}@example.test`, { ip: burstIp })).toEqual({ ok: true })
    expect(await subscribeToVacancy(v.token, 'p6@example.test', { ip: burstIp })).toEqual({ ok: false, code: 'rate_limited' })
  })

  it('возобновление: письмо уходит (mailpit), подписка удаляется, повтор писем не шлёт; снова пауза — не шлёт ничего', async () => {
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'smtp', Secrets.SECRET_KEYS.smtp.HOST, 'localhost')
    await Secrets.setSecret({ tenantId, actorId: adminId }, 'smtp', Secrets.SECRET_KEYS.smtp.PORT, '1025')
    const v = await newVacancy('Підписка лист')
    await pauseVacancy(hr, v.id)
    const addr = `vt-${Date.now()}@example.test`
    await subscribeToVacancy(v.token, addr, { ip: '198.51.100.42' })

    // Пока на паузе — задача не шлёт и подписку не трогает.
    expect(await notifyVacancySubscribers(tenantId, v.id)).toEqual({ sent: 0, failed: 0, skipped: 0 })

    const resumed = await publishVacancy(hr, v.id)
    expect(resumed.ok && resumed.resumed).toBe(true)
    expect(await notifyVacancySubscribers(tenantId, v.id)).toEqual({ sent: 1, failed: 0, skipped: 0 })
    expect((await admin`select count(*)::int as n from vacancy_subscribers where vacancy_id = ${v.id}`)[0]!.n).toBe(0)
    expect(await notifyVacancySubscribers(tenantId, v.id)).toEqual({ sent: 0, failed: 0, skipped: 0 })

    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`)
    const body = await res.json() as { messages: { ID: string, To: { Address: string }[] }[] }
    const msg = body.messages.find(m => m.To.some(t => t.Address === addr))
    expect(msg, 'лист підписнику не знайдено в mailpit').toBeTruthy()
    const text = (await (await fetch(`${MAILPIT}/api/v1/message/${msg!.ID}`)).json() as { Text: string }).Text
    expect(text).toContain(`/j/${v.token}`)
    expect(text).toContain(`${PREFIX}Підписка лист`)
  })

  it('первая публикация черновика — не «возобновление»', async () => {
    const created = await createVacancy(ctx, {
      title: `${PREFIX}Чернетка`, courseId, locationId, recruiterId, salaryCurrency: 'UAH', salaryVisible: false,
      publicApplyOtp: true, applyDailyCap: 200,
    } as Parameters<typeof createVacancy>[1])
    const r = await publishVacancy(hr, created.id)
    expect(r.ok && r.resumed).toBe(false)
  })
})

// ── vacancy.stats_rollup (§11, §9.1, §9.4) ───────────────────────────────────────────────

describe('vacancy.stats_rollup: свёртка публичной страницы', () => {
  it('просмотры, отправки и блокировки с причинами по суткам; повтор идемпотентен; уборка журнала свёртку не уменьшает', async () => {
    const v = await newVacancy('Згортка')
    await admin`delete from vacancy_stats_daily where vacancy_id = ${v.id}`
    const ins = (outcome: string, reason: string | null, ago: string) =>
      admin`insert into public_apply_attempts (tenant_id, vacancy_id, ip_hash, outcome, reason, created_at)
            values (${tenantId}, ${v.id}, 'h', ${outcome}, ${reason}, now() - ${ago}::interval)`
    for (let i = 0; i < 3; i++) await ins('view', null, '5 minutes')
    await ins('submit_ok', null, '5 minutes')
    await ins('submit_blocked', 'ip_hour', '5 minutes')
    await ins('submit_blocked', 'ip_hour', '5 minutes')
    await ins('submit_blocked', 'nonce_stale', '5 minutes')
    await ins('view', null, '3 days')

    await vacancyStatsRollupJob(tenantId)
    await vacancyStatsRollupJob(tenantId)
    const rows = await admin`select day, views, submits, blocked, block_reasons from vacancy_stats_daily where vacancy_id = ${v.id} order by day desc`
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ views: 3, submits: 1, blocked: 3, block_reasons: { ip_hour: 2, nonce_stale: 1 } })
    expect(rows[1]).toMatchObject({ views: 1, submits: 0, blocked: 0 })

    // Старый день вне окна пересчёта: журнал убран — строка свёртки остаётся прежней.
    await admin`update vacancy_stats_daily set day = day - 40 where vacancy_id = ${v.id} and views = 1`
    await admin`delete from public_apply_attempts where vacancy_id = ${v.id} and created_at < now() - interval '1 day'`
    await vacancyStatsRollupJob(tenantId)
    const old = await admin`select views from vacancy_stats_daily where vacancy_id = ${v.id} and day < current_date - 30`
    expect(old.map(r => r.views)).toEqual([1])
  })
})

// ── Чёрный список контактов (§7.7) ───────────────────────────────────────────────────────

describe('чёрный список контактов тенанта', () => {
  it('добавление: нормализация, маска вместо контакта, повтор — duplicate, мусор — invalid_contact', async () => {
    const added = await addToBlocklist(ctx, { contact: '067 994 00 01', reason: 'грубість' })
    expect(added.ok).toBe(true)
    if (added.ok) {
      expect(added.items[0]!.contactMasked).toBe('+380** *** ** 01')
      expect(added.items[0]!.contactMasked).not.toContain('9940001')
    }
    expect(await addToBlocklist(ctx, { contact: phone(1) })).toEqual({ ok: false, code: 'duplicate' })
    expect(await addToBlocklist(ctx, { contact: 'не контакт' })).toEqual({ ok: false, code: 'invalid_contact' })
    const stored = await admin`select contact_hash, contact_masked from contact_blocklist where tenant_id = ${tenantId}`
    expect(stored.some(r => String(r.contact_hash).includes('9940001'))).toBe(false)
    expect((await listBlocklist(ctx)).some(r => r.reason === 'грубість' && r.createdByName)).toBe(true)
    expect((await admin`select 1 from audit_log where tenant_id = ${tenantId} and action = 'contact_blocklist.add'`).length).toBeGreaterThan(0)
  })

  it('отклик с контактом из списка молча уходит в spam с причиной contact_blocked (+100)', async () => {
    await admin`delete from rate_limits where key like 'apply:%'`
    await addToBlocklist(ctx, { contact: 'Spammer@Example.test' })
    const v = await newVacancy('Чорний список')
    const r = await submitApplication(v.token, {
      fullName: 'Олена Коваль', email: 'spammer@example.test', consent: true,
      formNonce: signNonce(v.id, Date.now() - 30_000), website: '',
    }, { ip: '198.51.100.50' })
    expect(r.ok).toBe(true) // снаружи ответ тот же, что и у чистого отклика (§7.3)
    const [app] = await admin`select state, spam_score, spam_reasons from vacancy_applications where vacancy_id = ${v.id}`
    expect(app!.state).toBe('spam')
    expect(app!.spam_score).toBeGreaterThanOrEqual(100)
    expect(app!.spam_reasons).toContain('contact_blocked')
  })

  it('«До чорного списку» из отклика заносит оба контакта; удаление — по id, чужой id — false', async () => {
    await admin`delete from rate_limits where key like 'apply:%'`
    const v = await newVacancy('Із відгуку')
    const r = await submitApplication(v.token, {
      fullName: 'Ігор Бондар', phone: phone(2), email: 'igor.vt@example.test', consent: true,
      formNonce: signNonce(v.id, Date.now() - 30_000), website: '',
    }, { ip: '198.51.100.51' })
    if (!r.ok) throw new Error('apply failed')
    const res = await blocklistApplication(ctx, v.id, r.applicationId, 'дубль')
    expect(res.ok && res.items.length).toBe(2)
    expect(await blocklistApplication(ctx, v.id, r.applicationId, null)).toEqual({ ok: false, code: 'duplicate' })
    expect(await blocklistApplication(ctx, v.id, '00000000-0000-0000-0000-000000000000', null)).toEqual({ ok: false, code: 'not_found' })
    // Состояние отклика не меняется — это отдельное решение человека.
    expect((await admin`select state from vacancy_applications where id = ${r.applicationId}`)[0]!.state).not.toBe('spam')

    expect(await withTenant(tenantId, null, tx => isContactBlocked(tx, tenantId, [phone(2)]))).toBe(true)
    if (!res.ok) return
    expect(await removeFromBlocklist(ctx, res.items[0]!.id)).toBe(true)
    expect(await removeFromBlocklist(ctx, res.items[0]!.id)).toBe(false)
    expect((await admin`select 1 from audit_log where entity_id = ${res.items[0]!.id} and action = 'contact_blocklist.remove'`).length).toBe(1)
  })
})
