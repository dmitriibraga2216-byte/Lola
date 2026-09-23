import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR-15 пакета `docs/v2` (`45-plan.md`): вакансия — схема, критерии, шаблон параметров
 * (`29-vacancies.md` §3–§7, решение `44` В-13).
 *
 * Критерии приёмки `29` §13, закреплённые за этим PR:
 * - **1** — вакансия без курса не публикуется: `link_requirements`, токен не выдан,
 *   состояние осталось `draft`; то же правило стоит констрейнтом в БД;
 * - **8** — правка вакансии не меняет ни одного поля уже созданного назначения, а форма
 *   получает «Кандидатів у роботі: N»;
 * - **11** — веса 3, 1, 1 и баллы 5, 2, 0 по шкале 0–5 дают одну `candidate_scores` с
 *   `kind='recruiter'` и `value_num = 6.80`, предыдущая теряет `is_current`;
 * - **13** — закрытие вакансии с кандидатами в работе не прерывает прохождение, ссылка
 *   умирает, рекрутер получает список этих кандидатов;
 * - **14** — чужой тенант получает «не знайдено», а не «заборонено».
 *
 * Плюс условие выхода PR-15: **вакансия не стала вторым носителем правил прохождения**.
 * Проверяется не только грепом по схеме (`tests/unit/vacancy-rules.spec.ts`), но и
 * поведением: назначение, созданное по шаблону, живёт своей жизнью.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  createVacancy, updateVacancy, getVacancy, listVacancies, publishVacancy, pauseVacancy,
  closeVacancy, archiveVacancy, rotateToken, addCriterion, listCriteria, updateCriterion,
  deleteCriterion, saveCriterionScores, assignFromVacancy, viewerOf,
} = await import('../../server/services/vacancies')
const { createTemplate, listTemplates, templateFromVacancy, vacancyFromTemplate } = await import('../../server/services/vacancyTemplates')
const { createCandidate } = await import('../../server/services/candidates')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PREFIX = 'v2-15 '
const PHONES = ['+380679915001', '+380679915002', '+380679915003', '+380679915004']

let tenantId: string
let otherTenantId: string
let adminId: string
let recruiterId: string
let courseId: string
let courseVersionId: string
let locationId: string
let ctx: { tenantId: string, actorId: string }
let hr: ReturnType<typeof viewerOf>
let manager: ReturnType<typeof viewerOf>

function viewer(grants: { scopes: string[], scopeType: string, scopeId: string | null }[], userId = adminId) {
  return viewerOf({ userId, tenantId, grants })
}

async function cleanup() {
  const people = await admin`select id from users where phone in ${admin(PHONES)}`
  for (const p of people) {
    await admin`delete from vacancy_criterion_scores where candidate_id = ${p.id}`
    await admin`delete from candidate_scores where candidate_id = ${p.id}`
    await admin`delete from candidate_status_history where candidate_id = ${p.id}`
    await admin`delete from enrollments where user_id = ${p.id}`
    await admin`delete from audit_log where entity_id = ${p.id}`
    await admin`delete from users where id = ${p.id}`
  }
  await admin`delete from assignments where title like ${`${PREFIX}%`}`
  const vs = await admin`select id from vacancies where title like ${`${PREFIX}%`}`
  for (const v of vs) {
    await admin`update users set vacancy_id = null where vacancy_id = ${v.id}`
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin`delete from vacancy_templates where name like ${`${PREFIX}%`}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  const course = (await admin`select id, published_version_id from courses where tenant_id = ${tenantId} and status = 'published' order by title limit 1`)[0]!
  courseId = course.id as string
  courseVersionId = course.published_version_id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewer([{ scopes: ['vacancy.view', 'vacancy.edit', 'vacancy.publish', 'vacancy.close', 'vacancy.criteria.manage'], scopeType: 'tenant', scopeId: null }])
  manager = viewer([{ scopes: ['vacancy.view'], scopeType: 'location', scopeId: locationId }], recruiterId)
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

const draft = (over: Record<string, unknown> = {}) => ({
  title: `${PREFIX}Бариста`,
  salaryCurrency: 'UAH',
  salaryVisible: false,
  publicApplyOtp: true,
  applyDailyCap: 200,
  ...over,
})

async function newCandidate(phone: string, vacancyId: string | null) {
  const r = await createCandidate(ctx, {
    firstName: 'Кандидат', lastName: `Вакансії${phone.slice(-1)}`, phone,
    commLanguage: 'uk', consentGiven: true, confirmDuplicate: false,
    ...(vacancyId ? { vacancyId } : {}),
  } as never)
  if (!r.ok) throw new Error(`кандидат не создан: ${r.code}`)
  return r.candidate.id
}

// ── Критерий 1: публичная ссылка не существует без курса и точки ──────────────────────────

describe('§13 к. 1 — публикация без курса', () => {
  it('отклоняется, токен не выдан, состояние осталось draft', async () => {
    const v = await createVacancy(ctx, draft({ locationId }) as never)
    const r = await publishVacancy(hr, v.id)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('link_requirements')
    expect(r.ok === false && r.code === 'link_requirements' && r.missing).toContain('courseId')

    const after = await getVacancy(hr, v.id)
    expect(after!.state).toBe('draft')
    expect(after!.publicToken).toBeNull()
    expect(after!.publicEnabled).toBe(false)
  })

  it('то же правило стоит констрейнтом: прямой UPDATE мимо сервиса ссылку не создаёт', async () => {
    const v = await createVacancy(ctx, draft({ locationId }) as never)
    await expect(
      admin`update vacancies set public_enabled = true, public_token = 'abc' where id = ${v.id}`,
    ).rejects.toThrow(/vacancies_public_chk/)
  })

  it('заполненная вакансия публикуется, получает 22-значный токен и фиксирует версию курса', async () => {
    const v = await createVacancy(ctx, draft({ locationId, courseId, recruiterId }) as never)
    const r = await publishVacancy(hr, v.id)
    expect(r.ok).toBe(true)
    const card = await getVacancy(hr, v.id)
    expect(card!.state).toBe('published')
    expect(card!.publicEnabled).toBe(true)
    expect(card!.publicToken).toMatch(/^[A-Za-z0-9]{22}$/)
    // Правка курса не меняет отбор на лету (§3.1): версия снята в момент публикации.
    expect(card!.courseVersionId).toBe(courseVersionId)
  })
})

// ── Критерий 8: правка вакансии не трогает созданное назначение ───────────────────────────

describe('§13 к. 8 — правка вакансии не меняет уже созданных назначений', () => {
  it('назначение по шаблону создаётся, а последующая правка вакансии его не касается', async () => {
    const v = await createVacancy(ctx, draft({
      title: `${PREFIX}Кухар`,
      locationId,
      courseId,
      recruiterId,
      assignmentTemplate: { dueMode: 'relative', dueDays: 3, isMandatory: true, params: { passScore: 70 }, notifyOnAssign: true },
    }) as never)
    await publishVacancy(hr, v.id)
    const candidateId = await newCandidate(PHONES[0]!, v.id)

    const assigned = await withTenant(tenantId, adminId, tx => assignFromVacancy(tx, ctx, v.id, candidateId))
    expect(assigned.ok).toBe(true)
    const assignmentId = assigned.ok ? assigned.assignmentId : ''

    const snapshot = async () => (await admin`
      select params, due_days, due_mode, is_mandatory, subject_version_id, tags, title, reminders
        from assignments where id = ${assignmentId}`)[0]!
    const before = await snapshot()
    expect((before.params as Record<string, unknown>).passScore).toBe(70)
    expect(before.due_days).toBe(3)
    expect(before.tags as string[]).toContain(`vacancy:${v.id}`)
    // Версия курса — та, что зафиксирована вакансией при публикации (§3.1).
    expect(before.subject_version_id).toBe(courseVersionId)

    // Меняем проходной балл и курс в самой вакансии.
    const upd = await updateVacancy(hr, v.id, {
      assignmentTemplate: { dueMode: 'relative', dueDays: 30, isMandatory: false, params: { passScore: 95 }, notifyOnAssign: false },
    } as never)
    expect(upd.ok).toBe(true)
    // Форма получает счётчик для строки «Кандидатів у роботі: N» (§7.12).
    expect(upd.ok === true && upd.vacancy.candidatesInProgress).toBe(1)

    // Поле в поле: ни одно поле назначения не изменилось от правки вакансии.
    const after = await snapshot()
    expect(after).toEqual(before)
    expect((after.params as Record<string, unknown>).passScore).toBe(70)
    expect(after.due_days).toBe(3)
    expect(after.is_mandatory).toBe(true)
    expect(after.subject_version_id).toBe(courseVersionId)
  })

  it('шаблон вакансии не хранит правил сам: ключи режет тот же фильтр, что и форму назначения', async () => {
    const v = await createVacancy(ctx, draft({
      title: `${PREFIX}Фільтр`,
      locationId,
      courseId,
      recruiterId,
      // «Кількість питань» — ключ теста, а не курса: до назначения он не доедет.
      assignmentTemplate: { params: { passScore: 60, questionsCount: 10 } },
    }) as never)
    const candidateId = await newCandidate(PHONES[1]!, v.id)
    const assigned = await withTenant(tenantId, adminId, tx => assignFromVacancy(tx, ctx, v.id, candidateId))
    expect(assigned.ok).toBe(true)
    const params = (await admin`select params from assignments where id = ${assigned.ok ? assigned.assignmentId : ''}`)[0]!.params as Record<string, unknown>
    expect(params.passScore).toBe(60)
    expect(params.questionsCount).toBeUndefined()
  })
})

// ── Критерий 11: свёртка критериев в оценку рекрутера ─────────────────────────────────────

describe('§13 к. 11 — критерии сворачиваются в одну оценку рекрутера', () => {
  it('веса 3, 1, 1 и баллы 5, 2, 0 дают 6.80, предыдущая оценка теряет is_current', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Критерії`, locationId, courseId, recruiterId }) as never)
    const c1 = await addCriterion(hr, v.id, { name: 'Досвід', weight: 3, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'manual', sort: 0, isActive: true } as never)
    const c2 = await addCriterion(hr, v.id, { name: 'Комунікація', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'manual', sort: 1, isActive: true } as never)
    const c3 = await addCriterion(hr, v.id, { name: 'Мотивація', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: true, origin: 'manual', sort: 2, isActive: true } as never)
    expect(typeof c1 === 'string' || typeof c2 === 'string' || typeof c3 === 'string').toBe(false)

    const candidateId = await newCandidate(PHONES[2]!, v.id)
    // Первая оценка — чтобы было чему потерять is_current.
    await saveCriterionScores(hr, candidateId, { scores: [{ criterionId: (c1 as { id: string }).id, valueNum: 1 }] })

    const r = await saveCriterionScores(hr, candidateId, {
      scores: [
        { criterionId: (c1 as { id: string }).id, valueNum: 5 },
        { criterionId: (c2 as { id: string }).id, valueNum: 2 },
        { criterionId: (c3 as { id: string }).id, valueNum: 0 },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.ok === true && Number(r.score.valueNum)).toBe(6.8)
    // Критический критерий с минимальным баллом — предупреждение, а не запрет (инвариант 18).
    expect(r.ok === true && r.criticalLow).toEqual(['Мотивація'])

    const rows = await admin`
      select value_num, is_current, source_type, comment from candidate_scores
       where candidate_id = ${candidateId} and kind = 'recruiter' order by created_at`
    expect(rows.length).toBe(2)
    expect(rows[0]!.is_current).toBe(false)
    expect(rows[1]!.is_current).toBe(true)
    expect(Number(rows[1]!.value_num)).toBe(6.8)
    expect(rows[1]!.source_type).toBe('vacancy_criteria')
    expect(rows[1]!.comment).toBe('Оцінено за 3 критеріями')
  })

  it('балл вне шкалы своего критерия отвергается, а не обрезается молча', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Шкала`, locationId, courseId, recruiterId }) as never)
    const c = await addCriterion(hr, v.id, { name: 'Досвід', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'manual', sort: 0, isActive: true } as never)
    const candidateId = await newCandidate(PHONES[3]!, v.id)
    const r = await saveCriterionScores(hr, candidateId, { scores: [{ criterionId: (c as { id: string }).id, valueNum: 9 }] })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('out_of_scale')
  })

  it('критерии правятся и удаляются, чужая вакансия критериев не отдаёт', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}CRUD`, locationId, courseId, recruiterId }) as never)
    const c = await addCriterion(hr, v.id, { name: 'Досвід', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'manual', sort: 0, isActive: true } as never)
    const upd = await updateCriterion(hr, v.id, (c as { id: string }).id, { weight: 2 })
    expect(typeof upd === 'string' ? upd : Number(upd.weight)).toBe(2)
    // Шкала не может схлопнуться правкой: проверка идёт по строке в БД, а не только по телу.
    expect(await updateCriterion(hr, v.id, (c as { id: string }).id, { scaleMax: -1 })).toBe('bad_scale')
    expect(await deleteCriterion(hr, v.id, (c as { id: string }).id)).toBe('ok')
    expect(await listCriteria(hr, v.id)).toEqual([])
  })
})

// ── Критерий 13: закрытие с кандидатами в работе ──────────────────────────────────────────

describe('§13 к. 13 — закрытие вакансии с кандидатами в работе', () => {
  it('прохождение не прервано, ссылка умерла, рекрутер получил список из трёх', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Закриття`, locationId, courseId, recruiterId }) as never)
    await publishVacancy(hr, v.id)

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const [row] = await admin`
        insert into users (tenant_id, kind, candidate_state, full_name, first_name, last_name, status, vacancy_id, recruiter_id, comm_language, consent_given_at)
        values (${tenantId}, 'candidate', 'active', ${`${PREFIX}Кандидат ${i}`}, 'Кандидат', ${`Закриття${i}`}, 'invited', ${v.id}, ${recruiterId}, 'uk', now())
        returning id`
      ids.push(row!.id as string)
    }

    const assigned = await withTenant(tenantId, adminId, tx => assignFromVacancy(tx, ctx, v.id, ids[0]!))
    expect(assigned.ok).toBe(true)

    const r = await closeVacancy(hr, v.id, { reason: 'no_need', removeExternal: true, notifyCandidates: false })
    expect(r.ok).toBe(true)
    expect(r.candidates?.length).toBe(3)

    const card = await getVacancy(hr, v.id)
    expect(card!.state).toBe('closed')
    expect(card!.publicEnabled).toBe(false)
    expect(card!.publicToken).toBeNull()
    expect(card!.closeReason).toBe('no_need')

    // Прохождение не прервано: назначение и состояние кандидатов не изменились.
    const a = (await admin`select status from assignments where id = ${assigned.ok ? assigned.assignmentId : ''}`)[0]!
    expect(a.status).toBe('active')
    const states = await admin`select candidate_state from users where id in ${admin(ids)}`
    expect(states.map(s => s.candidate_state)).toEqual(['active', 'active', 'active'])

    // Архивация заблокирована, пока по людям не принято решение.
    const arch = await archiveVacancy(hr, v.id)
    expect(arch.ok).toBe(false)
    expect(arch.ok === false && arch.code).toBe('has_candidates')

    for (const id of ids) {
      await admin`delete from enrollments where user_id = ${id}`
      await admin`update users set vacancy_id = null where id = ${id}`
      await admin`delete from users where id = ${id}`
    }
  })

  it('переоткрытие закрытой вакансии выдаёт новый токен, старый мёртв', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Переоткриття`, locationId, courseId, recruiterId }) as never)
    await publishVacancy(hr, v.id)
    const first = (await getVacancy(hr, v.id))!.publicToken
    await closeVacancy(hr, v.id, { reason: 'postponed', removeExternal: true, notifyCandidates: false })
    await publishVacancy(hr, v.id)
    const second = (await getVacancy(hr, v.id))!.publicToken
    expect(second).toMatch(/^[A-Za-z0-9]{22}$/)
    expect(second).not.toBe(first)
  })

  it('приостановка оставляет токен: снятие объявлений с площадок стоит денег', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Пауза`, locationId, courseId, recruiterId }) as never)
    await publishVacancy(hr, v.id)
    const token = (await getVacancy(hr, v.id))!.publicToken
    const r = await pauseVacancy(hr, v.id)
    expect(r.ok).toBe(true)
    const card = await getVacancy(hr, v.id)
    expect(card!.state).toBe('paused')
    expect(card!.publicToken).toBe(token)
    // «Оновити посилання» (§7.8) убивает старую ссылку немедленно.
    await rotateToken(hr, v.id)
    expect((await getVacancy(hr, v.id))!.publicToken).not.toBe(token)
  })
})

// ── Критерий 14: чужой тенант и чужая область ─────────────────────────────────────────────

describe('§13 к. 14 — чужой тенант получает «не знайдено»', () => {
  it('карточка чужого тенанта не видна, и это 404, а не 403', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Ізоляція`, locationId, courseId, recruiterId }) as never)
    const stranger = viewerOf({ userId: adminId, tenantId: otherTenantId, grants: [{ scopes: ['vacancy.view', 'vacancy.edit'], scopeType: 'tenant', scopeId: null }] })
    expect(await getVacancy(stranger, v.id)).toBeNull()
    const upd = await updateVacancy(stranger, v.id, { title: 'Захоплення' })
    expect(upd.ok).toBe(false)
    expect(upd.ok === false && upd.code).toBe('not_found')
    expect((await listVacancies(stranger, { limit: 50 } as never)).map(r => r.id)).not.toContain(v.id)
  })

  it('RLS отсекает строку на уровне базы, а не только сервиса', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}RLS`, locationId, courseId, recruiterId }) as never)
    const rows = await withTenant(otherTenantId, adminId, async tx =>
      tx.execute(`select id from vacancies where id = '${v.id}'`) as unknown as { id: string }[])
    expect([...rows]).toHaveLength(0)
  })

  it('областная роль видит вакансии своей точки и те, где она рекрутер', async () => {
    const mine = await createVacancy(ctx, draft({ title: `${PREFIX}Моя точка`, locationId, courseId, recruiterId }) as never)
    const foreign = await createVacancy(ctx, draft({ title: `${PREFIX}Чужа точка`, courseId, recruiterId: adminId }) as never)
    const ids = (await listVacancies(manager, { limit: 100 } as never)).map(r => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(foreign.id)
    expect(await getVacancy(manager, foreign.id)).toBeNull()
  })
})

// ── Шаблоны (§3.4, §7.21) ─────────────────────────────────────────────────────────────────

describe('шаблоны вакансий (§3.4, §7.21)', () => {
  it('«Зберегти шаблон» снимает значения без точки и рекрутера, вместе с критериями', async () => {
    const v = await createVacancy(ctx, draft({
      title: `${PREFIX}Джерело шаблону`, locationId, courseId, recruiterId,
      employmentType: 'shift', city: 'Одеса',
      languages: [{ langCode: 'uk', level: 'native', isRequired: true, sort: 0 }],
    }) as never)
    await addCriterion(hr, v.id, { name: 'Досвід', weight: 2, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'manual', sort: 0, isActive: true } as never)

    const t = await templateFromVacancy(hr, v.id, { name: `${PREFIX}Шаблон бариста` })
    expect(t.ok).toBe(true)
    const payload = t.ok ? t.template.payload as Record<string, unknown> : {}
    expect(payload.employmentType).toBe('shift')
    expect(payload.city).toBe('Одеса')
    // Точка и рекрутер — свойство набора, а не позиции (§3.4).
    expect(payload.locationId).toBeUndefined()
    expect(payload.recruiterId).toBeUndefined()
    expect((t.ok ? t.template.criteria : []).length).toBe(1)
    expect((t.ok ? t.template.languages : []).length).toBe(1)

    const made = await vacancyFromTemplate(ctx, t.ok ? t.template.id : '', { locationId, recruiterId, title: `${PREFIX}З шаблону` })
    expect(made.ok).toBe(true)
    const card = made.ok ? await getVacancy(hr, made.vacancy.id) : null
    expect(card!.state).toBe('draft')
    expect(card!.locationId).toBe(locationId)
    expect(card!.employmentType).toBe('shift')
    expect(card!.criteria.length).toBe(1)
    expect(card!.criteria[0]!.origin).toBe('template')
    expect(card!.languages.length).toBe(1)

    const used = (await admin`select usage_count from vacancy_templates where id = ${t.ok ? t.template.id : ''}`)[0]!
    expect(used.usage_count).toBe(1)
  })

  it('шаблон с занятым именем — 409, а не второй с тем же названием', async () => {
    const first = await createTemplate(ctx, { name: `${PREFIX}Унікальний`, payload: {}, criteria: [], languages: [] } as never)
    expect(first.ok).toBe(true)
    const second = await createTemplate(ctx, { name: `${PREFIX}Унікальний`, payload: {}, criteria: [], languages: [] } as never)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.code).toBe('name_exists')
    expect((await listTemplates(ctx)).filter(t => t.name === `${PREFIX}Унікальний`).length).toBe(1)
  })

  it('шаблон не попадает в реестр вакансий — это не вакансия-черновик (§3.4)', async () => {
    await createTemplate(ctx, { name: `${PREFIX}Не вакансія`, payload: { title: `${PREFIX}Не вакансія` }, criteria: [], languages: [] } as never)
    const titles = (await listVacancies(hr, { limit: 200 } as never)).map(r => r.title)
    expect(titles).not.toContain(`${PREFIX}Не вакансія`)
  })
})

// ── Оптимистическая блокировка и архив ────────────────────────────────────────────────────

describe('правка вакансии', () => {
  it('устаревший updatedAt даёт 409 и актуальную версию, а не затирает чужую правку', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Конфлікт`, locationId, courseId, recruiterId }) as never)
    const stale = new Date(v.updatedAt.getTime() - 1000).toISOString()
    const r = await updateVacancy(hr, v.id, { title: `${PREFIX}Пізніше`, updatedAt: stale } as never)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('conflict')
  })

  it('архивная вакансия не правится: архив — не место для тихих изменений', async () => {
    const v = await createVacancy(ctx, draft({ title: `${PREFIX}Архів`, locationId, courseId, recruiterId }) as never)
    expect((await archiveVacancy(hr, v.id)).ok).toBe(true)
    const r = await updateVacancy(hr, v.id, { title: `${PREFIX}Архів правлений` } as never)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('state_locked')
  })
})
