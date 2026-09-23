import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-14 пакета `docs/v2` (`45-plan.md`): воронка кандидатов — канбан, транзакция найма,
 * две ночные задачи, отчёт и флаг `candidates_enabled`
 * (`28-recruiting-candidates.md` §4.3, §5.2, §7.4–§7.9, §9, §11).
 *
 * Критерии приёмки `28` §13, закреплённые за этим PR:
 * - **1** — сверх лимита кандидат не создаётся и счётчик не меняется (ось `candidates_active`
 *   после найма и отказа освобождает место);
 * - **3** — провал последней попытки обязательного задания **не** ставит отказ: состояние
 *   остаётся `active`, колонка становится «На перевірці», рекрутеру уходит уведомление;
 * - **4** — найм: `kind = 'employee'`, прогресс и оценки на том же `user_id`, лимит
 *   кандидатов −1, лимит сотрудников +1, в `audit_log` есть `candidate.hired`;
 * - **7** — отказанный 31 день назад при настройке 30 дней уходит в архив ночной задачей;
 * - **8** — по истёкшему согласию ПД стёрты, прохождение и оценки целы, запись в `audit_log`;
 * - **12** — 250 карточек в колонке отдаются страницей по 50 с курсором, ответ ≤ 400 мс.
 *
 * Плюс условия выхода PR-14: найм меняет обе оси ровно на единицу **одной транзакцией**,
 * карточка до и после найма совпадает поле в поле, флаг `candidates_enabled` включается тенанту.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  createCandidate, getCandidate, listCandidates, countActive, viewerOf,
} = await import('../../server/services/candidates')
const { hireCandidate, rejectCandidate, archiveCandidate, reopenCandidate } = await import('../../server/services/candidateHire')
const { board, boardColumn, bulkStatus, funnelReport } = await import('../../server/services/candidateFunnel')
const { candidateAutoArchive, candidateConsentSweep, syncCandidateStatusTx } = await import('../../server/services/candidateJobs')
const { recruitingSettings, updateRecruiting } = await import('../../server/services/settings')
const { isRecruitingEnabled, isRecruitingRoute, recruitingTenantIds, invalidateRecruiting } = await import('../../server/services/modules')
const { measureLive } = await import('../../server/services/usageCounters')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = '+38067991'
const MARK = 'PR14'

let tenantId: string
let otherTenantId: string
let adminId: string
let recruiterId: string
let locationId: string
let positionId: string
let hr: ReturnType<typeof viewerOf>
let ctx: { tenantId: string, actorId: string }
/**
 * Все заведённые спекой люди — поимённо. По шаблону имени и телефона их не вычистить:
 * `candidate.consent_sweep` **стирает** телефон и переименовывает человека в «Кандидат №…»
 * (§7.9), и обезличенная запись вместе со своим прохождением пережила бы уборку. Её запись
 * на курс лежит на том же курсе, который берут соседние спеки, и делает его «залоченным»
 * для смены этапа — файлы гоняются по одной базе.
 */
const seeded: string[] = []

function viewer(scopes: string[], scopeType = 'tenant', userId?: string) {
  return viewerOf({ userId: userId ?? adminId, tenantId, grants: [{ scopes, scopeType, scopeId: null }] })
}

/** Кандидат напрямую в БД: массовые сценарии доски не должны упираться в скорость сервиса. */
async function seedCandidate(n: number, patch: Record<string, unknown> = {}) {
  const [statusNew] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId,
      kind: 'candidate',
      candidate_state: 'active',
      candidate_state_at: new Date(),
      candidate_status_id: statusNew!.id,
      full_name: `${MARK} Кандидат ${n}`,
      phone: `${PREFIX}${String(n).padStart(4, '0')}`,
      status: 'invited',
      source: 'manual',
      recruiter_id: recruiterId,
      consent_given_at: new Date(),
      consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      ...patch,
    })} returning id`
  await admin`
    insert into candidate_status_history (tenant_id, candidate_id, to_status_id, actor_id)
    values (${tenantId}, ${row!.id}, ${statusNew!.id}, ${adminId})`
  seeded.push(row!.id as string)
  return row!.id as string
}

/** Запись прохождения кандидата: `enrollments.version_id` — not null, берём версию курса. */
async function seedEnrollment(userId: string, status: 'done' | 'in_progress', pct: number) {
  const [course] = await admin`
    select c.id, v.id as version_id from courses c
      join course_versions v on v.course_id = c.id
     where c.tenant_id = ${tenantId} limit 1`
  await admin`
    insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, source, status, progress_pct)
    values (${tenantId}, ${userId}, 'course', ${course!.id}, ${course!.version_id}, 'assignment', ${status}, ${pct})`
  return course!.id as string
}

/** Обязательное назначение — для правила §7.4 «провал обязательного задания». */
async function seedMandatoryAssignment(courseId: string) {
  const [row] = await admin`
    insert into assignments (tenant_id, title, subject_type, subject_id, audience, is_mandatory, status, created_by)
    values (${tenantId}, ${`${MARK} обовʼязкове`}, 'course', ${courseId}, ${admin.json({ rules: [], match: 'any' })}, true, 'active', ${adminId})
    returning id`
  return row!.id as string
}

async function cleanup() {
  const byPattern = await admin`select id from users where tenant_id = ${tenantId} and (phone like ${`${PREFIX}%`} or full_name like ${`${MARK}%`})`
  const ids = new Set<string>([...byPattern.map(r => r.id as string), ...seeded])
  for (const r of [...ids].map(id => ({ id }))) {
    await admin`delete from candidate_scores where candidate_id = ${r.id}`
    await admin`delete from candidate_comments where candidate_id = ${r.id}`
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from employee_lifecycle_state where user_id = ${r.id}`
    await admin`delete from functional_chiefs where user_id = ${r.id} or chief_id = ${r.id}`
    await admin`delete from user_placements where user_id = ${r.id}`
    await admin`delete from user_roles where user_id = ${r.id}`
    await admin`delete from notifications where user_id = ${r.id} or ref_id = ${r.id}`
    await admin`delete from enrollments where user_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'candidate_%'`
  await admin`delete from assignments where tenant_id = ${tenantId} and title like ${`${MARK}%`}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewer(['candidate.view', 'candidate.edit', 'candidate.decide', 'candidate.hire', 'candidate.delete', 'candidate.status.manage'])
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  // Флаг возвращается в исходное состояние: включённый рекрутинг не должен течь в соседние
  // файлы — они гоняются на той же базе и ничего про воронку не знают.
  await admin`update tenants set candidates_enabled = false where id = ${tenantId}`
  await admin.end()
})

// ── Флаг тенанта (условие выхода PR-14) ───────────────────────────────────────────────────

describe('флаг candidates_enabled: рекрутинг включается тенантом', () => {
  it('по умолчанию выключен, включается через настройки и гасится обратно', async () => {
    await admin`update tenants set candidates_enabled = false where id = ${tenantId}`
    invalidateRecruiting(tenantId)
    expect(await isRecruitingEnabled(tenantId)).toBe(false)

    const on = await updateRecruiting(ctx, { enabled: true })
    expect(on.enabled).toBe(true)
    expect(await isRecruitingEnabled(tenantId)).toBe(true)
    // Флаг живёт в колонке, а не в settings: второй копии у него быть не должно (В-14).
    const [t] = await admin`select candidates_enabled, settings -> 'recruiting' as group_ from tenants where id = ${tenantId}`
    expect(t!.candidates_enabled, 'флаг живёт в колонке tenants.candidates_enabled').toBe(true)
    expect((t!.group_ as Record<string, unknown> | null)?.enabled, 'копии флага в settings быть не должно').toBeUndefined()

    const off = await updateRecruiting(ctx, { enabled: false })
    expect(off.enabled).toBe(false)
    expect(await isRecruitingEnabled(tenantId)).toBe(false)

    // Включение пишется в audit_log и в журнал безопасности: это открытие раздела с ПД.
    const [audit] = await admin`
      select count(*)::int as n from audit_log
       where tenant_id = ${tenantId} and action = 'settings.recruiting'`
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(2)

    await updateRecruiting(ctx, { enabled: true })
  })

  it('сроки воронки настраиваются и валидируются диапазоном документа (§7.5, §7.9)', async () => {
    const s = await updateRecruiting(ctx, { archiveAfterDays: 45, consentMonths: 12 })
    expect(s.archiveAfterDays).toBe(45)
    expect(s.consentMonths).toBe(12)
    await expect(updateRecruiting(ctx, { archiveAfterDays: 3 })).rejects.toThrow()
    await expect(updateRecruiting(ctx, { consentMonths: 99 })).rejects.toThrow()
    const back = await recruitingSettings(ctx)
    expect(back.archiveAfterDays).toBe(45)
    await updateRecruiting(ctx, { archiveAfterDays: 30, consentMonths: 6 })
  })

  it('маршруты воронки узнаются по префиксу, публичный контур откликов — нет', () => {
    expect(isRecruitingRoute('/api/v1/candidates')).toBe(true)
    expect(isRecruitingRoute('/api/v1/candidates/abc/hire')).toBe(true)
    expect(isRecruitingRoute('/api/v1/candidate-statuses')).toBe(true)
    expect(isRecruitingRoute('/api/v1/reports/recruiting-funnel?from=2026-01-01')).toBe(true)
    expect(isRecruitingRoute('/api/v1/people')).toBe(false)
    expect(isRecruitingRoute('/api/v1/public/j/token')).toBe(false)
  })

  it('круг ночных задач строится только по тенантам с включённым рекрутингом (§11)', async () => {
    const ids = await recruitingTenantIds()
    expect(ids).toContain(tenantId)
    expect(ids).not.toContain(otherTenantId)
  })
})

// ── Канбан (§5.2, критерий §13 к. 12) ─────────────────────────────────────────────────────

describe('канбан воронки: 250 карточек в колонке (критерий §13 к. 12)', () => {
  let statusNewId: string

  beforeAll(async () => {
    statusNewId = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`)[0]!.id as string
    // Двести пятьдесят карточек в одной колонке — ровно случай из критерия приёмки.
    const values = []
    for (let i = 1; i <= 250; i++) values.push(i)
    for (const i of values) await seedCandidate(i)
  }, 120_000)

  it('первая страница — 50 карточек, курсор и полное число колонки', async () => {
    const started = Date.now()
    const columns = await board(hr, { limit: 50 })
    const elapsed = Date.now() - started
    const col = columns.find(c => c.statusId === statusNewId)!
    expect(col.cards.length).toBe(50)
    expect(col.total).toBeGreaterThanOrEqual(250)
    expect(col.nextCursor).not.toBeNull()
    // Критерий §13 к. 12: время ответа ≤ 400 мс. Меряем сервис — HTTP сверху добавляет
    // десятки миллисекунд, а деградация, ради которой писался индекс, видна именно здесь.
    expect(elapsed, `доска строилась ${elapsed} мс`).toBeLessThanOrEqual(400)
  })

  it('«Показати ще» добирает следующую страницу той же колонки без дублей и пропусков', async () => {
    const seen = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    let total = 0
    do {
      const page = await boardColumn(hr, statusNewId, { limit: 50, ...(cursor ? { cursor } : {}) })
      expect(page).not.toBeNull()
      for (const c of page!.cards) {
        expect(seen.has(c.id), `карточка ${c.id} пришла дважды`).toBe(false)
        seen.add(c.id)
      }
      total = page!.total
      cursor = page!.nextCursor ?? undefined
      pages += 1
    } while (cursor && pages < 12)
    expect(seen.size).toBe(total)
    expect(seen.size).toBeGreaterThanOrEqual(250)
  }, 60_000)

  it('терминальные колонки карточек не грузят, но счётчик показывают', async () => {
    const columns = await board(hr, { limit: 50 })
    const rejected = columns.find(c => c.mapsTo === 'rejected')!
    expect(rejected.cards.length).toBe(0)
    expect(typeof rejected.total).toBe('number')
  })

  it('чужая колонка (в том числе чужого тенанта) — «не найдено», а не «запрещено»', async () => {
    const [foreign] = await admin`
      insert into candidate_statuses (tenant_id, code, name_uk, sort, maps_to)
      values (${otherTenantId}, 'pr14_foreign', 'Чужа колонка', 90, 'active')
      on conflict (tenant_id, code) do update set sort = 90 returning id`
    expect(await boardColumn(hr, foreign!.id as string, { limit: 50 })).toBeNull()
    await admin`delete from candidate_statuses where id = ${foreign!.id}`
  })

  it('массовый перенос колонок не делает найма: он транзакция, а не смена статуса (§6.3, §7.6)', async () => {
    const ids = (await admin`
      select id from users where tenant_id = ${tenantId} and full_name like ${`${MARK}%`} limit 3`).map(r => r.id as string)
    const [hiredCol] = await admin`
      insert into candidate_statuses (tenant_id, code, name_uk, sort, maps_to)
      values (${tenantId}, 'pr14_hired', 'Найняті', 91, 'hired')
      on conflict (tenant_id, code) do update set maps_to = 'hired' returning id`
    const res = await bulkStatus(hr, { ids, statusId: hiredCol!.id as string, notify: false })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.changed).toBe(0)
      expect(res.skipped.every(s => s.reason === 'hire_is_not_bulk')).toBe(true)
    }
    const [check] = await admin`select count(*)::int as n from users where id in ${admin(ids)} and kind = 'employee'`
    expect(Number(check!.n)).toBe(0)
    await admin`delete from candidate_statuses where id = ${hiredCol!.id}`
  })
})

// ── Найм (§7.6, критерий §13 к. 4, условия выхода PR-14) ──────────────────────────────────

describe('транзакция найма: та же запись users, обе оси на единицу', () => {
  let candidateId: string
  let before: Record<string, unknown>

  beforeAll(async () => {
    const created = await createCandidate(ctx, {
      firstName: 'Ганна', lastName: `${MARK}Найм`, phone: `${PREFIX}5001`,
      consentGiven: true, confirmDuplicate: false, commLanguage: 'uk',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('кандидат не создан')
    candidateId = created.candidate.id
    seeded.push(candidateId)
    // Оценка и комментарий — то, что обязано пережить найм на том же `user_id` (§7.6).
    await admin`
      insert into candidate_scores (tenant_id, candidate_id, kind, value_num, author_id)
      values (${tenantId}, ${candidateId}, 'manual', 8.5, ${adminId})`
    await admin`
      insert into candidate_comments (tenant_id, candidate_id, author_id, body)
      values (${tenantId}, ${candidateId}, ${adminId}, 'Сильний кандидат')`
    await seedEnrollment(candidateId, 'done', 100)
    const card = await getCandidate(hr, candidateId)
    before = card as unknown as Record<string, unknown>
  })

  it('найм: −1 кандидат, +1 сотрудник, вторая запись человека не появляется', async () => {
    const usersBefore = await measureLive(tenantId, 'users_active')
    const candidatesBefore = await measureLive(tenantId, 'candidates_active')
    const peopleBefore = Number((await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n)

    const res = await hireCandidate(hr, candidateId, {
      locationId, positionId, startDate: new Date().toISOString().slice(0, 10),
      onboardingCourseIds: [], welcomeLetter: false,
    })
    expect(res.ok, `найм не прошёл: ${JSON.stringify(res)}`).toBe(true)
    if (!res.ok) return

    const usersAfter = await measureLive(tenantId, 'users_active')
    const candidatesAfter = await measureLive(tenantId, 'candidates_active')
    expect(usersAfter - usersBefore, 'ось users_active обязана вырасти ровно на 1').toBe(1)
    expect(candidatesBefore - candidatesAfter, 'ось candidates_active обязана упасть ровно на 1').toBe(1)
    expect(res.outcome.usersActive).toBe(usersAfter)
    expect(res.outcome.candidatesActive).toBe(candidatesAfter)

    // Главное правило модуля: людей не стало больше — сменился вид у той же строки (§3.1).
    const peopleAfter = Number((await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n)
    expect(peopleAfter).toBe(peopleBefore)

    const [row] = await admin`
      select kind, candidate_state, candidate_status_id, status, hired_at, converted_from_candidate_at, access_until
        from users where id = ${candidateId}`
    expect(row!.kind).toBe('employee')
    // §3.2 сильнее §7.6: у сотрудника состояния воронки нет, факт хранят две даты.
    expect(row!.candidate_state).toBeNull()
    expect(row!.candidate_status_id).toBeNull()
    expect(row!.status).toBe('active')
    expect(row!.hired_at).not.toBeNull()
    expect(row!.converted_from_candidate_at).not.toBeNull()
    expect(row!.access_until).toBeNull()
  })

  it('размещение, этап онбординга и запись в audit_log — той же транзакцией (критерий §13 к. 4)', async () => {
    const [placement] = await admin`
      select location_id, position_id, is_primary from user_placements
       where user_id = ${candidateId} and ended_at is null`
    expect(placement, 'найм обязан создать размещение').toBeDefined()
    expect(placement!.location_id).toBe(locationId)
    expect(placement!.is_primary).toBe(true)

    const [stage] = await admin`
      select s.code from employee_lifecycle_state st
        join lifecycle_stages s on s.id = st.stage_id
       where st.user_id = ${candidateId} and st.is_current`
    expect(stage?.code, 'новый сотрудник встаёт на этап онбординга').toBe('onboarding')

    const [audit] = await admin`
      select after from audit_log where entity_id = ${candidateId} and action = 'candidate.hired'`
    expect(audit, 'в audit_log нет записи candidate.hired').toBeDefined()
  })

  it('карточка до и после найма совпадает поле в поле: прогресс и оценки на том же user_id', async () => {
    const [scores] = await admin`select count(*)::int as n from candidate_scores where candidate_id = ${candidateId}`
    const [comments] = await admin`select count(*)::int as n from candidate_comments where candidate_id = ${candidateId}`
    const [enrollments] = await admin`select count(*)::int as n, max(progress_pct) as pct from enrollments where user_id = ${candidateId}`
    expect(Number(scores!.n)).toBe(1)
    expect(Number(comments!.n)).toBe(1)
    expect(Number(enrollments!.n)).toBe(1)
    expect(Number(enrollments!.pct)).toBe(100)

    // Поле в поле: всё, что не относится к воронке, обязано совпасть с карточкой до найма.
    const [after] = await admin`
      select full_name, phone, email, source, recruiter_id, comm_language, consent_given_at, created_at
        from users where id = ${candidateId}`
    for (const key of ['fullName', 'phone', 'email', 'source', 'commLanguage'] as const) {
      const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)
      expect(String(after![col] ?? ''), `поле ${key} изменилось при найме`).toBe(String(before[key] ?? ''))
    }
    expect(new Date(after!.created_at as Date).getTime()).toBe(new Date(before.createdAt as Date).getTime())
    expect(String(after!.recruiter_id ?? '')).toBe(String(before.recruiterId ?? ''))
  })

  it('нанятый исчез из воронки и не вернётся в неё ни одним переходом (критерий §13 к. 11)', async () => {
    const list = await listCandidates(hr, { limit: 200 })
    expect(list.some(c => c.id === candidateId)).toBe(false)
    const back = await reopenCandidate(hr, candidateId, { reasonText: 'помилка найму' })
    expect(back.ok).toBe(false)
    if (!back.ok) expect(back.code).toBe('not_found') // сотрудник — уже не кандидат ни для одной выборки
    const [row] = await admin`select kind from users where id = ${candidateId}`
    expect(row!.kind).toBe('employee')
  })

  it('найм неактивного кандидата отклоняется, запись не меняется (§7.6)', async () => {
    const created = await createCandidate(ctx, {
      firstName: 'Олег', lastName: `${MARK}Відмова`, phone: `${PREFIX}5002`,
      consentGiven: true, confirmDuplicate: false, commLanguage: 'uk',
    })
    if (!created.ok) throw new Error('кандидат не создан')
    seeded.push(created.candidate.id)
    const rejected = await rejectCandidate(hr, created.candidate.id, { reasonCode: 'skills', notify: false })
    expect(rejected.ok).toBe(true)
    const res = await hireCandidate(hr, created.candidate.id, {
      locationId, positionId, startDate: new Date().toISOString().slice(0, 10),
      onboardingCourseIds: [], welcomeLetter: false,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('not_active')
    const [row] = await admin`select kind, candidate_state from users where id = ${created.candidate.id}`
    expect(row!.kind).toBe('candidate')
    expect(row!.candidate_state).toBe('rejected')
  })
})

// ── Ночные задачи (§7.5, §7.9; критерии §13 к. 7 и к. 8) ──────────────────────────────────

describe('candidate.auto_archive: отказ старше N дней уходит в архив (критерий §13 к. 7)', () => {
  it('31 день при настройке 30 — архив; свежий отказ остаётся отказом', async () => {
    await updateRecruiting(ctx, { autoArchiveRejected: true, archiveAfterDays: 30 })
    const old = await seedCandidate(9001, {
      candidate_state: 'rejected',
      candidate_state_at: new Date(Date.now() - 31 * 86_400_000),
    })
    const fresh = await seedCandidate(9002, {
      candidate_state: 'rejected',
      candidate_state_at: new Date(Date.now() - 2 * 86_400_000),
    })

    const n = await candidateAutoArchive(tenantId)
    expect(n).toBeGreaterThanOrEqual(1)

    const [oldRow] = await admin`select candidate_state from users where id = ${old}`
    const [freshRow] = await admin`select candidate_state from users where id = ${fresh}`
    expect(oldRow!.candidate_state).toBe('archived')
    expect(freshRow!.candidate_state).toBe('rejected')

    const [audit] = await admin`
      select after from audit_log where entity_id = ${old} and action = 'candidate.archived' order by created_at desc limit 1`
    expect(audit, 'архивация обязана попасть в audit_log').toBeDefined()
  })

  it('выключенный тумблер останавливает задачу целиком (§7.5)', async () => {
    await updateRecruiting(ctx, { autoArchiveRejected: false })
    const old = await seedCandidate(9003, {
      candidate_state: 'rejected',
      candidate_state_at: new Date(Date.now() - 90 * 86_400_000),
    })
    expect(await candidateAutoArchive(tenantId)).toBe(0)
    const [row] = await admin`select candidate_state from users where id = ${old}`
    expect(row!.candidate_state).toBe('rejected')
    await updateRecruiting(ctx, { autoArchiveRejected: true })
  })
})

describe('candidate.consent_sweep: стирание ПД по истёкшему согласию (критерий §13 к. 8)', () => {
  it('ФИО, контакты, резюме и комментарии стёрты; прохождение и оценки целы', async () => {
    const id = await seedCandidate(9101, {
      consent_expires_at: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      email: 'pr14-consent@kappi.test',
    })
    await admin`
      insert into candidate_scores (tenant_id, candidate_id, kind, value_num, author_id)
      values (${tenantId}, ${id}, 'task', 7, ${adminId})`
    await admin`
      insert into candidate_comments (tenant_id, candidate_id, author_id, body)
      values (${tenantId}, ${id}, ${adminId}, 'Коментар про людину')`
    await seedEnrollment(id, 'done', 100)

    const res = await candidateConsentSweep(tenantId)
    expect(res.erased).toBeGreaterThanOrEqual(1)

    const [row] = await admin`
      select full_name, phone, email, resume_asset_id, anonymized_at, candidate_state, is_blocked
        from users where id = ${id}`
    expect(String(row!.full_name)).toContain('Кандидат №')
    expect(row!.phone).toBeNull()
    expect(row!.email).toBeNull()
    expect(row!.resume_asset_id).toBeNull()
    expect(row!.anonymized_at).not.toBeNull()
    expect(row!.candidate_state).toBe('archived')
    expect(row!.is_blocked).toBe(true)

    const [comments] = await admin`select count(*)::int as n from candidate_comments where candidate_id = ${id}`
    expect(Number(comments!.n), 'комментарии о человеке стираются вместе с ПД').toBe(0)
    const [scores] = await admin`select count(*)::int as n from candidate_scores where candidate_id = ${id}`
    const [enrollments] = await admin`select count(*)::int as n from enrollments where user_id = ${id}`
    expect(Number(scores!.n), 'оценки остаются обезличенной статистикой воронки').toBe(1)
    expect(Number(enrollments!.n), 'прохождение остаётся').toBe(1)

    const [audit] = await admin`
      select action from audit_log where entity_id = ${id} and action = 'candidate.anonymized'`
    expect(audit, 'стирание обязано попасть в audit_log').toBeDefined()
  })

  it('повторный проход ничего не трогает: операция идемпотентна по anonymized_at', async () => {
    const first = await candidateConsentSweep(tenantId)
    const second = await candidateConsentSweep(tenantId)
    expect(second.erased).toBe(0)
    expect(first.erased).toBeGreaterThanOrEqual(0)
  })

  it('за 14 дней до стирания рекрутер получает предупреждение (§7.9)', async () => {
    const id = await seedCandidate(9102, {
      consent_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    })
    const res = await candidateConsentSweep(tenantId)
    expect(res.warned).toBeGreaterThanOrEqual(1)
    const [n] = await admin`
      select count(*)::int as n from notifications
       where tenant_id = ${tenantId} and code = 'candidate_consent_expiring' and user_id = ${recruiterId}`
    expect(Number(n!.n)).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select anonymized_at from users where id = ${id}`
    expect(row!.anonymized_at, 'предупреждение не стирает данные').toBeNull()
  })
})

// ── Авто-переходы колонки (§4.3, §7.4; критерий §13 к. 3) ─────────────────────────────────

describe('автоматика: провал обязательного задания не равен отказу (критерий §13 к. 3)', () => {
  it('провал ставит «На перевірці», состояние остаётся active, рекрутеру уходит уведомление', async () => {
    const id = await seedCandidate(9201)
    const courseId = await seedEnrollment(id, 'done', 100)
    const assignmentId = await seedMandatoryAssignment(courseId)

    const target = await withTenant(tenantId, adminId, tx =>
      syncCandidateStatusTx(tx, tenantId, id, 'failed', assignmentId))
    expect(target).toBe('on_review')

    const [row] = await admin`
      select u.candidate_state, s.code from users u
        left join candidate_statuses s on s.id = u.candidate_status_id
       where u.id = ${id}`
    expect(row!.candidate_state, 'система не отказывает автоматически ни при каком результате').toBe('active')
    expect(row!.code).toBe('on_review')

    const [history] = await admin`
      select is_automatic, reason_code from candidate_status_history
       where candidate_id = ${id} order by created_at desc limit 1`
    expect(history!.is_automatic).toBe(true)
    expect(history!.reason_code).toBe('task_failed')

    const [notice] = await admin`
      select count(*)::int as n from notifications
       where tenant_id = ${tenantId} and code = 'candidate_review_needed' and user_id = ${recruiterId}`
    expect(Number(notice!.n)).toBeGreaterThanOrEqual(1)
  })

  it('успешное завершение без открытых назначений — «На перевірці» и «потрібне рішення»', async () => {
    const id = await seedCandidate(9202)
    const target = await withTenant(tenantId, adminId, tx => syncCandidateStatusTx(tx, tenantId, id, 'done', null))
    expect(target).toBe('on_review')
    const [notice] = await admin`
      select count(*)::int as n from notifications
       where tenant_id = ${tenantId} and code = 'candidate_completed' and ref_id = ${id}`
    expect(Number(notice!.n)).toBeGreaterThanOrEqual(1)
  })

  it('успешное завершение при открытом назначении — «Проходять»', async () => {
    const id = await seedCandidate(9203)
    await seedEnrollment(id, 'in_progress', 40)
    const target = await withTenant(tenantId, adminId, tx => syncCandidateStatusTx(tx, tenantId, id, 'done', null))
    expect(target).toBe('in_progress')
  })

  it('сотрудника автоматика не трогает: колонок воронки у него нет', async () => {
    const target = await withTenant(tenantId, adminId, tx => syncCandidateStatusTx(tx, tenantId, adminId, 'failed', null))
    expect(target).toBeNull()
  })
})

// ── Отчёт по воронке (§9 п. 1, единый каркас docs/22 §13) ─────────────────────────────────

describe('отчёт по воронке: агрегат по колонкам и люди единым каркасом', () => {
  it('колонки, доли и конверсия считаются, пользовательская колонка не выпадает (§4.1)', async () => {
    const [custom] = await admin`
      insert into candidate_statuses (tenant_id, code, name_uk, sort, maps_to)
      values (${tenantId}, 'pr14_callback', 'Передзвонити', 92, 'active')
      on conflict (tenant_id, code) do update set maps_to = 'active' returning id`
    const id = await seedCandidate(9301, { candidate_status_id: custom!.id })
    await admin`
      insert into candidate_status_history (tenant_id, candidate_id, to_status_id, actor_id)
      values (${tenantId}, ${id}, ${custom!.id}, ${adminId})`

    const report = await funnelReport(hr, { format: 'json' })
    const stage = report.stages.find(s => s.code === 'pr14_callback')
    expect(stage, 'пользовательская колонка обязана быть в отчёте').toBeDefined()
    expect(stage!.mapsTo).toBe('active')
    expect(stage!.entered).toBeGreaterThanOrEqual(1)
    expect(report.summary.entered).toBeGreaterThan(0)
    expect(report.summary.hired, 'найм считается по converted_from_candidate_at').toBeGreaterThanOrEqual(1)

    await admin`update users set candidate_status_id = null where id = ${id}`
    await admin`delete from candidate_status_history where candidate_id = ${id}`
    await admin`delete from candidate_statuses where id = ${custom!.id}`
  })

  it('список людей идёт единым каркасом колонок и содержит только кандидатов (П-16.1)', async () => {
    const report = await funnelReport(hr, { format: 'json' })
    expect(report.rows.length).toBeGreaterThan(0)
    for (const key of ['user_id', 'full_name', 'position', 'city', 'unit', 'tags']) {
      expect(Object.keys(report.rows[0]!), `в каркасе нет колонки ${key}`).toContain(key)
    }
    const ids = report.rows.map(r => String(r.user_id))
    const [employees] = await admin`
      select count(*)::int as n from users where id in ${admin(ids)} and kind = 'employee'`
    expect(Number(employees!.n), 'в отчёте по кандидатам не должно быть сотрудников').toBe(0)
  })

  it('чужой тенант в отчёт не попадает (CLAUDE.md п. 15)', async () => {
    const [foreignStatus] = await admin`
      insert into candidate_statuses (tenant_id, code, name_uk, sort, maps_to)
      values (${otherTenantId}, 'pr14_other', 'Чужа', 93, 'active')
      on conflict (tenant_id, code) do update set sort = 93 returning id`
    const [foreign] = await admin`
      insert into users (tenant_id, kind, candidate_state, candidate_status_id, full_name, phone, status)
      values (${otherTenantId}, 'candidate', 'active', ${foreignStatus!.id}, 'Чужий кандидат', '+380679919999', 'invited')
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name returning id`

    const report = await funnelReport(hr, { format: 'json' })
    expect(report.rows.some(r => String(r.user_id) === String(foreign!.id))).toBe(false)
    expect(report.stages.some(s => s.code === 'pr14_other')).toBe(false)
    const columns = await board(hr, { limit: 50 })
    expect(columns.some(c => c.code === 'pr14_other')).toBe(false)

    await admin`delete from users where id = ${foreign!.id}`
    await admin`delete from candidate_statuses where id = ${foreignStatus!.id}`
  })
})

// ── Ось лимита после решений (критерий §13 к. 1) ──────────────────────────────────────────

describe('ось candidates_active: место освобождают отказ, архив и найм (§7.1)', () => {
  it('отказ и архивация уменьшают счётчик, возврат в воронку его снова занимает', async () => {
    const created = await createCandidate(ctx, {
      firstName: 'Ірина', lastName: `${MARK}Ліміт`, phone: `${PREFIX}5003`,
      consentGiven: true, confirmDuplicate: false, commLanguage: 'uk',
    })
    if (!created.ok) throw new Error('кандидат не создан')
    const id = created.candidate.id
    seeded.push(id)

    const start = await countActive(hr)
    expect((await rejectCandidate(hr, id, { reasonCode: 'experience', notify: false })).ok).toBe(true)
    expect(await countActive(hr)).toBe(start - 1)

    expect((await archiveCandidate(hr, id, {})).ok).toBe(true)
    expect(await countActive(hr)).toBe(start - 1)

    const back = await reopenCandidate(hr, id, { reasonText: 'передумали' })
    expect(back.ok, `возврат не прошёл: ${JSON.stringify(back)}`).toBe(true)
    expect(await countActive(hr)).toBe(start)
  })

  it('возврат невозможен, если согласие истекло (§4.2)', async () => {
    const id = await seedCandidate(9401, {
      candidate_state: 'archived',
      consent_expires_at: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
    })
    const res = await reopenCandidate(hr, id, { reasonText: 'спроба повернення' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('consent_expired')
  })
})
