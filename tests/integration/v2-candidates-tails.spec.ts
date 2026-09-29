import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Хвосты блока «Кандидаты» (`docs/v2/46-progress.md` «Известные долги», `docs/v2/28` §5.1–§5.3,
 * §7.9, §7.12, §8, §10):
 *
 * - `GET /candidates` — страницы ключевым курсором (`KEYSETS.candidates`), `total` под фильтром;
 * - фильтр доски и списка по вакансии (`users.vacancy_id`);
 * - `POST /candidates/:id/invite` — ссылка входа и `candidate_invited` по каналам, частота §7.12
 *   (раз в сутки, пять всего), `contact.missing`, закрытый вход;
 * - `DELETE /candidates/:id` — обезличивание по праву на забвение, `409` нанятому, `404` чужому;
 * - вкладка «Проходження» — назначения, попытки, зачтённое время.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { listCandidates, viewerOf } = await import('../../server/services/candidates')
const { board, boardColumn } = await import('../../server/services/candidateFunnel')
const { inviteCandidate, deleteCandidate, INVITE_INTERVAL_MS, INVITE_MAX_TOTAL } = await import('../../server/services/candidateInvite')
const { candidateProgress } = await import('../../server/services/candidateProgress')
const { candidateListSchema, candidateBoardSchema, candidateInviteSchema, candidateDeleteSchema } = await import('../../shared/schemas/candidates')
const { renderTemplate, DEFAULT_TEMPLATES } = await import('../../server/services/notifications')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = '+38067992'
const MARK = 'CTAILS'

let tenantId: string
let adminId: string
let recruiterId: string
let vacancyA: string
let vacancyB: string
let hr: ReturnType<typeof viewerOf>
const seeded: string[] = []

function viewer(scopes: string[], scopeType = 'tenant', userId?: string, tenant?: string) {
  return viewerOf({ userId: userId ?? adminId, tenantId: tenant ?? tenantId, grants: [{ scopes, scopeType, scopeId: null }] })
}

let seq = 0
async function seedCandidate(patch: Record<string, unknown> = {}) {
  seq += 1
  const [statusNew] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId,
      kind: 'candidate',
      candidate_state: 'active',
      candidate_state_at: new Date(),
      candidate_status_id: statusNew!.id,
      full_name: `${MARK} Кандидат ${seq}`,
      phone: `${PREFIX}${String(seq).padStart(4, '0')}`,
      email: `ctails${seq}@example.com`,
      status: 'invited',
      source: 'manual',
      recruiter_id: recruiterId,
      consent_given_at: new Date(),
      consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      ...patch,
    })} returning id`
  seeded.push(row!.id as string)
  return row!.id as string
}

async function cleanup() {
  const byPattern = await admin`select id from users where tenant_id = ${tenantId} and (phone like ${`${PREFIX}%`} or full_name like ${`${MARK}%`})`
  const ids = new Set<string>([...byPattern.map(r => r.id as string), ...seeded])
  for (const id of ids) {
    await admin`delete from learning_time_totals where user_id = ${id}`
    await admin`delete from attempts where user_id = ${id}`
    await admin`delete from enrollments where user_id = ${id}`
    await admin`delete from invitations where user_id = ${id}`
    await admin`delete from candidate_comments where candidate_id = ${id}`
    await admin`delete from candidate_status_history where candidate_id = ${id}`
    await admin`delete from notifications where user_id = ${id} or ref_id = ${id}`
    await admin`delete from sessions where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
  await admin`delete from vacancies where tenant_id = ${tenantId} and title like ${`${MARK}%`}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  await cleanup()
  vacancyA = (await admin`insert into vacancies (tenant_id, title) values (${tenantId}, ${`${MARK} Бариста`}) returning id`)[0]!.id as string
  vacancyB = (await admin`insert into vacancies (tenant_id, title) values (${tenantId}, ${`${MARK} Кухар`}) returning id`)[0]!.id as string
  hr = viewer(['candidate.view', 'candidate.edit', 'candidate.assign', 'candidate.decide', 'candidate.hire', 'candidate.delete'])
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

// ── GET /candidates: ключевой курсор ──────────────────────────────────────────────────────

describe('GET /candidates — страницы ключевым курсором (`28` §10, docs/04 §4.1)', () => {
  it('обходит весь список без дублей и пропусков, даже когда кандидаты созданы в одну микросекунду', async () => {
    const at = new Date()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await seedCandidate({ created_at: at, vacancy_id: vacancyA }))
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await listCandidates(hr, candidateListSchema.parse({ vacancyId: vacancyA, limit: 3, ...(cursor ? { cursor } : {}) }))
      expect(page.total).toBe(7)
      seen.push(...page.items.map(r => r.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(7)
    expect([...seen].sort()).toEqual([...ids].sort())
  })

  it('последняя страница — без курсора; битый курсор не проходит схему (422, а не первая страница)', async () => {
    const page = await listCandidates(hr, candidateListSchema.parse({ vacancyId: vacancyA, limit: 50 }))
    expect(page.nextCursor).toBeNull()
    expect(page.items.every(r => r.vacancyId === vacancyA)).toBe(true)
    expect(candidateListSchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false)
    // Прежний формат — голый uuid последней строки — тоже больше не курсор
    expect(candidateListSchema.safeParse({ cursor: page.items[0]!.id }).success).toBe(false)
  })

  it('контакты в странице — по объёму видимости (§7.10): областная роль видит маску', async () => {
    const own = viewer(['candidate.view'], 'location', recruiterId)
    const page = await listCandidates(own, candidateListSchema.parse({ vacancyId: vacancyA, limit: 2 }))
    expect(page.items.length).toBe(2)
    expect(page.items[0]!.phone).toMatch(/^\+380\*\* \*\*\* \*\* \d\d$/)
  })

  it('чужой тенант не видит ни строк, ни итога', async () => {
    const [other] = await admin`
      insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
      on conflict (slug) do update set name = excluded.name returning id`
    const foreign = viewer(['candidate.view'], 'tenant', adminId, other!.id as string)
    const page = await listCandidates(foreign, candidateListSchema.parse({ vacancyId: vacancyA }))
    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
  })
})

// ── Фильтр доски по вакансии ──────────────────────────────────────────────────────────────

describe('доска: фильтр по вакансии (`28` §5.1, §5.2)', () => {
  it('колонка и доска считают только кандидатов вакансии, карточка несёт название вакансии', async () => {
    const b1 = await seedCandidate({ vacancy_id: vacancyB })
    const b2 = await seedCandidate({ vacancy_id: vacancyB })
    const columns = await board(hr, candidateBoardSchema.parse({ vacancyId: vacancyB }))
    const all = columns.flatMap(c => c.cards)
    expect(all.map(c => c.id).sort()).toEqual([b1, b2].sort())
    expect(all.every(c => c.vacancyTitle === `${MARK} Кухар` && c.vacancyId === vacancyB)).toBe(true)
    expect(columns.reduce((n, c) => n + c.total, 0)).toBe(2)

    const newCol = columns.find(c => c.cards.length)!
    const page = await boardColumn(hr, newCol.statusId, candidateBoardSchema.parse({ vacancyId: vacancyB, limit: 1 }))
    expect(page!.total).toBe(2)
    expect(page!.cards.length).toBe(1)
    const next = await boardColumn(hr, newCol.statusId, candidateBoardSchema.parse({ vacancyId: vacancyB, limit: 1, cursor: page!.nextCursor! }))
    expect(next!.cards.map(c => c.id)).not.toContain(page!.cards[0]!.id)
    expect(next!.nextCursor).toBeNull()
  })

  it('без фильтра кандидаты обеих вакансий на доске', async () => {
    const columns = await board(hr, candidateBoardSchema.parse({}))
    const titles = new Set(columns.flatMap(c => c.cards).map(c => c.vacancyTitle))
    expect(titles.has(`${MARK} Кухар`)).toBe(true)
  })
})

// ── POST /candidates/:id/invite ───────────────────────────────────────────────────────────

describe('POST /candidates/:id/invite (`28` §7.12, §8, §10)', () => {
  it('ссылка входа и `candidate_invited` по каждому доступному каналу; канал без контакта пропущен', async () => {
    const id = await seedCandidate({ vacancy_id: vacancyA, access_until: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) })
    const r = await inviteCandidate(hr, id, { channels: ['email', 'sms', 'telegram', 'email'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.channels.sort()).toEqual(['email', 'sms'])
    expect(r.skipped).toEqual(['telegram'])
    expect(r).not.toHaveProperty('url') // ссылка — только кандидату

    const inv = await admin`select expires_at, created_by, accepted_at from invitations where user_id = ${id}`
    expect(inv.length).toBe(1)
    expect(inv[0]!.created_by).toBe(adminId)
    const ttlH = (new Date(inv[0]!.expires_at as Date).getTime() - Date.now()) / 3_600_000
    expect(ttlH).toBeGreaterThan(47)
    expect(ttlH).toBeLessThanOrEqual(48)

    const notes = await admin`select channel, payload from notifications where user_id = ${id} and code = 'candidate_invited' order by channel`
    expect(notes.map(n => n.channel)).toEqual(['email', 'sms'])
    const payload = notes[0]!.payload as { vacancy: string, url: string, until: string }
    expect(payload.vacancy).toBe(`${MARK} Бариста`)
    expect(payload.url).toMatch(/\/invite\?token=[\w-]{20,}$/)
    expect(payload.until).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00Z$/)

    const [audit] = await admin`select after from audit_log where entity_id = ${id} and action = 'candidate.invited'`
    expect((audit!.after as { channels: string[], number: number }).number).toBe(1)
  })

  it('текст приглашения — с вакансией и без неё', () => {
    const tpl = DEFAULT_TEMPLATES.candidate_invited!
    expect(renderTemplate(tpl, { vacancy: 'Бариста', url: 'https://x/invite?token=a', until: '' }))
      .toBe('Вітаємо! Для участі у відборі на посаду «Бариста» пройдіть матеріали за посиланням: https://x/invite?token=a')
    expect(renderTemplate(tpl, { vacancy: '', url: 'u', until: '' })).toBe('Вітаємо! Для участі у відборі пройдіть матеріали за посиланням: u')
  })

  it('повтор раньше суток — `too_often` с моментом, когда можно; через сутки — можно', async () => {
    const id = await seedCandidate()
    const t0 = new Date()
    expect((await inviteCandidate(hr, id, { channels: ['email'] }, { now: t0 })).ok).toBe(true)
    const again = await inviteCandidate(hr, id, { channels: ['email'] }, { now: new Date(t0.getTime() + 60_000) })
    expect(again).toMatchObject({ ok: false, code: 'too_often', reason: 'interval' })
    if (!again.ok && again.code === 'too_often') expect(again.retryAt!.getTime()).toBe(t0.getTime() + INVITE_INTERVAL_MS)
    const later = await inviteCandidate(hr, id, { channels: ['email'] }, { now: new Date(t0.getTime() + INVITE_INTERVAL_MS + 1000) })
    expect(later.ok).toBe(true)
  })

  it('больше пяти приглашений всего — нельзя, даже через сутки', async () => {
    const id = await seedCandidate()
    const t0 = Date.now()
    for (let i = 0; i < INVITE_MAX_TOTAL; i++) {
      expect((await inviteCandidate(hr, id, { channels: ['email'] }, { now: new Date(t0 + i * (INVITE_INTERVAL_MS + 1000)) })).ok).toBe(true)
    }
    const sixth = await inviteCandidate(hr, id, { channels: ['email'] }, { now: new Date(t0 + 10 * INVITE_INTERVAL_MS) })
    expect(sixth).toMatchObject({ ok: false, code: 'too_often', reason: 'total', retryAt: null })
    expect((await admin`select count(*)::int as n from invitations where user_id = ${id}`)[0]!.n).toBe(INVITE_MAX_TOTAL)
  })

  it('ни одного адреса под выбранные каналы — `contact_missing`, ничего не создано', async () => {
    const id = await seedCandidate({ email: null })
    const r = await inviteCandidate(hr, id, { channels: ['email', 'telegram'] })
    expect(r).toEqual({ ok: false, code: 'contact_missing', missing: ['email', 'telegram'] })
    expect((await admin`select count(*)::int as n from invitations where user_id = ${id}`)[0]!.n).toBe(0)
  })

  it('не в отборе — `not_active`; истёк доступ — `access_expired`; чужая область — `not_found`', async () => {
    const rejected = await seedCandidate({ candidate_state: 'rejected' })
    expect(await inviteCandidate(hr, rejected, { channels: ['email'] })).toEqual({ ok: false, code: 'not_active', state: 'rejected' })

    const expired = await seedCandidate({ access_until: '2020-01-01' })
    expect(await inviteCandidate(hr, expired, { channels: ['email'] })).toEqual({ ok: false, code: 'access_expired' })

    const mine = await seedCandidate({ recruiter_id: adminId })
    const areal = viewer(['candidate.view', 'candidate.assign'], 'location', recruiterId)
    expect(await inviteCandidate(areal, mine, { channels: ['email'] })).toEqual({ ok: false, code: 'not_found' })

    // Сотрудник по id кандидата не приглашается этим путём — выборка только по `kind = 'candidate'`
    expect(await inviteCandidate(hr, adminId, { channels: ['email'] })).toEqual({ ok: false, code: 'not_found' })
  })

  it('схема: пустой список каналов и чужой канал отсекаются на входе', () => {
    expect(candidateInviteSchema.safeParse({ channels: [] }).success).toBe(false)
    expect(candidateInviteSchema.safeParse({ channels: ['push'] }).success).toBe(false)
    expect(candidateInviteSchema.safeParse({ channels: ['sms'] }).success).toBe(true)
  })
})

// ── DELETE /candidates/:id ────────────────────────────────────────────────────────────────

describe('DELETE /candidates/:id — право на забвение (`28` §2, §7.9, §10)', () => {
  it('ПД обезличены, прохождение цело, в audit_log причина, сессии закрыты; повтор — без ошибки', async () => {
    const id = await seedCandidate({ vacancy_id: vacancyA })
    const [course] = await admin`select c.id, v.id as version_id from courses c join course_versions v on v.course_id = c.id where c.tenant_id = ${tenantId} limit 1`
    await admin`insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, source, status, progress_pct)
                values (${tenantId}, ${id}, 'course', ${course!.id}, ${course!.version_id}, 'assignment', 'in_progress', 40)`
    await admin`insert into candidate_comments (tenant_id, candidate_id, author_id, body) values (${tenantId}, ${id}, ${adminId}, 'дзвонив')`

    expect(await deleteCandidate(hr, id, { reasonText: 'запит субʼєкта від 29.09' })).toEqual({ ok: true, erased: true })
    const [u] = await admin`select full_name, phone, email, candidate_state, anonymized_at from users where id = ${id}`
    expect(u!.full_name).toBe(`Кандидат №${id.slice(0, 8)}`)
    expect(u!.phone).toBeNull()
    expect(u!.email).toBeNull()
    expect(u!.candidate_state).toBe('archived')
    expect(u!.anonymized_at).not.toBeNull()
    expect((await admin`select count(*)::int as n from candidate_comments where candidate_id = ${id}`)[0]!.n).toBe(0)
    expect((await admin`select count(*)::int as n from enrollments where user_id = ${id}`)[0]!.n).toBe(1)
    const [audit] = await admin`select actor_id, after from audit_log where entity_id = ${id} and action = 'candidate.anonymized'`
    expect(audit!.actor_id).toBe(adminId)
    expect(audit!.after).toEqual({ reason: 'erasure_request', reasonText: 'запит субʼєкта від 29.09' })

    expect(await deleteCandidate(hr, id, { reasonText: 'ще раз' })).toEqual({ ok: true, erased: false })
    expect((await admin`select count(*)::int as n from audit_log where entity_id = ${id} and action = 'candidate.anonymized'`)[0]!.n).toBe(1)
  })

  it('нанятый — `hired`, ничего не стёрто', async () => {
    // Так выглядит нанятый (§7.6): сотрудник без оси кандидата, но с историей воронки
    const id = await seedCandidate({ kind: 'employee', candidate_state: null, candidate_status_id: null, status: 'active', hired_at: '2026-09-01' })
    const [st] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
    await admin`insert into candidate_status_history (tenant_id, candidate_id, to_status_id, actor_id) values (${tenantId}, ${id}, ${st!.id}, ${adminId})`
    expect(await deleteCandidate(hr, id, { reasonText: 'помилка' })).toEqual({ ok: false, code: 'hired' })
    const [u] = await admin`select phone from users where id = ${id}`
    expect(u!.phone).not.toBeNull()
  })

  it('сотрудник, чужой тенант и несуществующий id — `not_found`', async () => {
    expect(await deleteCandidate(hr, adminId, { reasonText: 'помилка' })).toEqual({ ok: false, code: 'not_found' })
    const [other] = await admin`select id from tenants where slug = 'test-isolation'`
    const id = await seedCandidate()
    const foreign = viewer(['candidate.view', 'candidate.delete'], 'tenant', adminId, other!.id as string)
    expect(await deleteCandidate(foreign, id, { reasonText: 'помилка' })).toEqual({ ok: false, code: 'not_found' })
    expect(await deleteCandidate(hr, '00000000-0000-4000-8000-000000000000', { reasonText: 'помилка' })).toEqual({ ok: false, code: 'not_found' })
  })

  it('причина обязательна', () => {
    expect(candidateDeleteSchema.safeParse({}).success).toBe(false)
    expect(candidateDeleteSchema.safeParse({ reasonText: 'ok' }).success).toBe(false)
    expect(candidateDeleteSchema.safeParse({ reasonText: 'запит' }).success).toBe(true)
  })
})

// ── Вкладка «Проходження» ─────────────────────────────────────────────────────────────────

describe('вкладка «Проходження» (`28` §5.3 п. 2)', () => {
  it('назначения со статусом, прогрессом, попытками и зачтённым временем; отменённые не видны', async () => {
    const id = await seedCandidate()
    const [course] = await admin`select c.id, c.title, v.id as version_id from courses c join course_versions v on v.course_id = c.id where c.tenant_id = ${tenantId} limit 1`
    const [e] = await admin`insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, source, status, progress_pct, due_at)
                values (${tenantId}, ${id}, 'course', ${course!.id}, ${course!.version_id}, 'assignment', 'in_progress', 55.5, now() - interval '1 day') returning id`
    const [second] = await admin`select c.id, v.id as version_id from courses c join course_versions v on v.course_id = c.id where c.tenant_id = ${tenantId} and c.id <> ${course!.id} limit 1`
    await admin`insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, source, status, cancelled_at)
                values (${tenantId}, ${id}, 'course', ${second!.id}, ${second!.version_id}, 'assignment', 'not_started', now())`
    const [quiz] = await admin`select id, title from quizzes where tenant_id = ${tenantId} limit 1`
    await admin`insert into attempts (tenant_id, quiz_id, enrollment_id, user_id, attempt_no, snapshot, params, status, score, max_score, passed, submitted_at)
                values (${tenantId}, ${quiz!.id}, ${e!.id}, ${id}, 1, '{}', '{}', 'failed', 3, 10, false, now())`
    await admin`insert into attempts (tenant_id, quiz_id, enrollment_id, user_id, attempt_no, snapshot, params, status)
                values (${tenantId}, ${quiz!.id}, ${e!.id}, ${id}, 2, '{}', '{}', 'annulled')`
    await admin`insert into learning_time_totals (tenant_id, user_id, enrollment_id, subject_type, subject_id, content_seconds, attempt_seconds)
                values (${tenantId}, ${id}, ${e!.id}, 'lesson', ${course!.id}, 600, 0),
                       (${tenantId}, ${id}, ${e!.id}, 'quiz', ${quiz!.id}, 30, 240)`

    const r = await candidateProgress(hr, id)
    expect(r!.items.length).toBe(1)
    expect(r!.items[0]).toMatchObject({
      enrollmentId: e!.id, title: course!.title, status: 'in_progress', progressPct: 55.5, overdue: true,
      attemptsCount: 1, contentSeconds: 630, attemptSeconds: 240,
    })
    expect(r!.attempts.length).toBe(1)
    expect(r!.attempts[0]).toMatchObject({ attemptNo: 1, status: 'failed', score: 3, maxScore: 10, passed: false, title: quiz!.title })
  })

  it('пусто у нового кандидата; чужая область и сотрудник — `null` (404)', async () => {
    const id = await seedCandidate({ recruiter_id: adminId })
    expect(await candidateProgress(hr, id)).toEqual({ items: [], attempts: [] })
    expect(await candidateProgress(viewer(['candidate.view'], 'location', recruiterId), id)).toBeNull()
    expect(await candidateProgress(hr, adminId)).toBeNull()
  })
})
