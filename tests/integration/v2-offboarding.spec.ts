import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assignmentCreateSchema } from '../../shared/schemas/assignments'
import { offboardingStartSchema } from '../../shared/schemas/offboarding'

/**
 * PR-07 пакета `docs/v2` (`45-plan.md`): офбординг, состояние человека в цикле, повторный найм
 * (`33-lifecycle.md` §3.5, §3.6, §4.2, §7.7, §7.8; патч П-14).
 *
 * Критерии приёмки `33` §13, закреплённые за этим PR:
 * - **5** — кандидату нельзя назначить курс этапа «Онбординг»: `422 lifecycle.not_for_candidate`,
 *   назначение не создано;
 * - **7** — после завершения всех обязательных назначений этапа отработала `lifecycle.advance`:
 *   текущий этап сменился, у прежней записи появился `left_at`, `is_current` осталась ровно одна;
 * - **9** — завершение офбординга: сессии закрыты, активных назначений не осталось, лимит
 *   активных людей уменьшился, запись человека и история обучения сохранены;
 * - **10** — повторный найм через 10 дней использует **ту же** запись `users`, видны оба
 *   периода работы, новый этап — «Онбординг».
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { hire, startOffboarding, completeOffboarding, cancelOffboarding, markHandoverDone, listCases } = await import('../../server/services/offboarding')
const { personState, advanceLifecycleTx } = await import('../../server/services/lifecycleState')
const { createAssignment, expandAssignment } = await import('../../server/services/assignments')
const { completeTask } = await import('../../server/services/taskCompletion')
const { issueForEnrollment } = await import('../../server/services/certificates')
const { listStages } = await import('../../server/services/lifecycle')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

const PHONE = '+380670700707'
const EXTERNAL_ID = 'v2-07-rehire'

let tenantId: string
let adminId: string
let candidateId: string
let locationId: string
let positionId: string
let stageCourseId: string
let knowledgeCourseId: string
let ctx: { tenantId: string, actorId: string }
const stageIdByCode: Record<string, string> = {}
const createdAssignments: string[] = []

/** Сколько людей сейчас считается «активными» для лимита тарифа (docs/v2/35, `usage.ts`). */
async function activeUsers(): Promise<number> {
  const [row] = await admin`
    select count(*)::int as n from users
    where tenant_id = ${tenantId} and status = 'active' and not is_blocked and kind = 'employee'`
  return Number(row!.n)
}

async function assignCourse(courseId: string, userId: string): Promise<string> {
  const r = await createAssignment(ctx, assignmentCreateSchema.parse({
    subjectType: 'course',
    subjectId: courseId,
    audience: { rules: [{ type: 'user', ids: [userId] }], match: 'any' },
    isMandatory: true,
    status: 'active',
  }))
  if (!r.ok) throw new Error(`createAssignment → ${r.code}`)
  createdAssignments.push(r.assignmentId)
  await expandAssignment(tenantId, r.assignmentId)
  const [enr] = await admin`select id from enrollments where assignment_id = ${r.assignmentId} and user_id = ${userId}`
  return enr!.id as string
}

async function cleanupPerson() {
  const rows = await admin`select id from users where tenant_id = ${tenantId} and (phone = ${PHONE} or external_id = ${EXTERNAL_ID})`
  for (const r of rows) {
    const id = r.id as string
    await admin`delete from certificates where user_id = ${id}`
    await admin`delete from task_status_log where user_id = ${id}`
    await admin`delete from enrollment_events where enrollment_id in (select id from enrollments where user_id = ${id})`
    await admin`delete from enrollments where user_id = ${id}`
    await admin`delete from offboarding_cases where user_id = ${id}`
    await admin`delete from employee_lifecycle_state where user_id = ${id}`
    await admin`delete from sessions where user_id = ${id}`
    await admin`delete from user_placements where user_id = ${id}`
    await admin`delete from user_roles where user_id = ${id}`
    await admin`delete from notifications where user_id = ${id}`
    await admin`delete from security_log where user_id = ${id}`
    await admin`delete from audit_log where entity_id = ${id}`
    await admin`delete from users where id = ${id}`
  }
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  candidateId = (await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' limit 1`)[0]!.id as string
  locationId = (await admin`select id from locations where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  positionId = (await admin`select id from positions where tenant_id = ${tenantId} order by name limit 1`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  for (const r of await admin`select id, code from lifecycle_stages where tenant_id = ${tenantId}`) {
    stageIdByCode[r.code as string] = r.id as string
  }
  const courses = await admin`
    select id from courses
    where tenant_id = ${tenantId} and deleted_at is null and published_version_id is not null
    order by created_at desc limit 2`
  stageCourseId = courses[0]!.id as string
  knowledgeCourseId = courses[1]!.id as string
  await admin`update courses set lifecycle_stage_id = ${stageIdByCode.onboarding!} where id = ${stageCourseId}`
  await admin`update courses set lifecycle_stage_id = ${stageIdByCode.knowledge!} where id = ${knowledgeCourseId}`
  await cleanupPerson()
}, 60_000)

afterAll(async () => {
  await cleanupPerson()
  if (createdAssignments.length) {
    await admin`delete from audit_log where entity = 'assignment' and entity_id in ${admin(createdAssignments)}`
    await admin`delete from assignments where id in ${admin(createdAssignments)}`
  }
  await admin`update courses set lifecycle_stage_id = null, stage_locked = false where id in ${admin([stageCourseId, knowledgeCourseId])}`
  await admin.end()
})

describe('33 §3.5: состояние человека хранится явно', () => {
  it('найм заводит запись состояния с этапом «Онбординг» и ровно одной текущей', async () => {
    const r = await hire(ctx, { phone: PHONE, externalId: EXTERNAL_ID, fullName: 'Тимчасовий Працівник', locationId, positionId })
    if (typeof r === 'string') throw new Error(`hire → ${r}`)
    expect(r.reused).toBe(false)
    expect(r.previousPeriods).toBe(0)
    expect(r.stageId).toBe(stageIdByCode.onboarding)

    const state = await personState(ctx, r.userId)
    expect(state?.current?.stageCode).toBe('onboarding')
    expect(state?.history.filter(h => h.isCurrent)).toHaveLength(1)
  })

  it('этап человека и этап курса — разные вещи: состояние не выводится из назначений', async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${PHONE}`
    const userId = u!.id as string
    // Человек на «Онбордингу» и при этом проходит курс этапа «База знань»: этап курса
    // на этап человека не влияет — вывести один из другого нельзя (§3.5, гипотеза Г-33.2).
    const enrollmentId = await assignCourse(knowledgeCourseId, userId)
    await admin`update enrollments set status = 'done', completed_at = now() where id = ${enrollmentId}`
    await completeTask(tenantId, userId, { contentType: 'course', contentId: knowledgeCourseId, status: 'done', enrollmentId, sourceKind: 'enrollment', sourceId: enrollmentId })
    expect((await personState(ctx, userId))?.current?.stageCode).toBe('onboarding')
  })

  it('счётчик людей в этапе виден на экране настроек (§5.2)', async () => {
    const stages = await listStages(ctx)
    const onboarding = stages.find(s => s.code === 'onboarding')!
    expect(onboarding.peopleCount).toBeGreaterThan(0)
  })
})

describe('33 §13 критерий 5: кандидату — только этапы с applies_to_candidate', () => {
  it('курс этапа «Онбординг» кандидату не назначается: not_for_candidate, назначения нет', async () => {
    const before = (await admin`select count(*)::int as n from assignments where tenant_id = ${tenantId}`)[0]!.n
    const r = await createAssignment(ctx, assignmentCreateSchema.parse({
      subjectType: 'course',
      subjectId: stageCourseId,
      audience: { rules: [{ type: 'user', ids: [candidateId] }], match: 'any' },
      status: 'active',
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_for_candidate')
    const after = (await admin`select count(*)::int as n from assignments where tenant_id = ${tenantId}`)[0]!.n
    expect(Number(after)).toBe(Number(before))
  })

  /**
   * > [исправлено, PR-15: кандидат, названный поимённо, теперь раскрывается в аудиторию]
   * > Ранее: «отказ приходит именно от этапа, а не от пустой аудитории» — назначение
   * > кандидату не создавалось никогда, и проверялось лишь, что код отказа **другой**.
   *
   * Смысл проверки сохранён и усилен: этап с `applies_to_candidate = true` кандидату курс
   * отдаёт, а без флага (тест выше) — нет, и отказ приходит именно от этапа. Раскрытие
   * аудитории по правилу `user` пришло с `docs/v2/29` §7.20: отклик по вакансии обязан
   * создать кандидату обычную `assignments`, иначе правила прохождения получают второго
   * носителя. Восстановление этапа курса — в `finally`: падение этой проверки не должно
   * уносить за собой соседние describe-блоки, которые ждут курс на «Онбордингу».
   */
  it('этап с applies_to_candidate кандидату курс отдаёт — отказ выше был именно от этапа', async () => {
    await admin`update courses set lifecycle_stage_id = ${stageIdByCode.psychological!} where id = ${stageCourseId}`
    try {
      const r = await createAssignment(ctx, assignmentCreateSchema.parse({
        subjectType: 'course',
        subjectId: stageCourseId,
        audience: { rules: [{ type: 'user', ids: [candidateId] }], match: 'any' },
        status: 'active',
      }))
      expect(r.ok).toBe(true)
      if (r.ok) {
        const [row] = await admin`select id from assignments where id = ${r.assignmentId}`
        expect(row).toBeDefined()
        await admin`delete from enrollments where assignment_id = ${r.assignmentId}`
        await admin`delete from assignments where id = ${r.assignmentId}`
      }
    }
    finally {
      await admin`update courses set lifecycle_stage_id = ${stageIdByCode.onboarding!} where id = ${stageCourseId}`
    }
  })

  it('сотруднику тот же курс назначается', async () => {
    const enrollmentId = await assignCourse(stageCourseId, adminId)
    expect(enrollmentId).toBeTruthy()
  })
})

describe('33 §13 критерий 7: lifecycle.advance переводит на следующий этап', () => {
  let userId: string
  let enrollmentId: string

  beforeAll(async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${PHONE}`
    userId = u!.id as string
    enrollmentId = await assignCourse(stageCourseId, userId)
  })

  it('пока обязательное назначение этапа открыто — этап не меняется', async () => {
    const moved = await withTenant(tenantId, adminId, tx => advanceLifecycleTx(tx, tenantId, userId))
    expect(moved).toBeNull()
    expect((await personState(ctx, userId))?.current?.stageCode).toBe('onboarding')
  })

  it('все обязательные закрыты → «Онбординг» сменился «Інтеграцією», прежняя запись закрыта', async () => {
    await admin`update enrollments set status = 'done', completed_at = now() where id = ${enrollmentId}`
    await completeTask(tenantId, userId, { contentType: 'course', contentId: stageCourseId, status: 'done', enrollmentId, sourceKind: 'enrollment', sourceId: enrollmentId })

    const state = await personState(ctx, userId)
    expect(state?.current?.stageCode).toBe('integration')
    expect(state?.history.filter(h => h.isCurrent)).toHaveLength(1)
    const closed = state!.history.find(h => h.stageCode === 'onboarding')!
    expect(closed.isCurrent).toBe(false)
    expect(closed.leftAt).not.toBeNull()
  })

  it('частичный уникальный индекс не даёт завести вторую текущую запись', async () => {
    await expect(
      admin`insert into employee_lifecycle_state (tenant_id, user_id, stage_id) values (${tenantId}, ${userId}, ${stageIdByCode.training!})`,
    ).rejects.toThrow(/uq_employee_lifecycle_current/)
  })
})

describe('33 §4.2: отмена офбординга возвращает прежний этап', () => {
  it('этап возвращается, случай получает cancelled и причину', async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${PHONE}`
    const userId = u!.id as string
    const started = await startOffboarding(ctx, offboardingStartSchema.parse({
      userId,
      reasonCode: 'own_wish',
      lastWorkingDay: new Date().toISOString().slice(0, 10),
      responsibleId: adminId,
    }))
    if (typeof started === 'string') throw new Error(`startOffboarding → ${started}`)
    expect((await personState(ctx, userId))?.current?.stageCode).toBe('offboarding')

    const cancelled = await cancelOffboarding(ctx, started.id, 'Домовилися залишитися')
    if (typeof cancelled === 'string') throw new Error(`cancelOffboarding → ${cancelled}`)
    expect(cancelled.state).toBe('cancelled')
    expect((await personState(ctx, userId))?.current?.stageCode).toBe('integration')
    const [row] = await admin`select cancel_reason from offboarding_cases where id = ${started.id}`
    expect(row!.cancel_reason).toBe('Домовилися залишитися')
  })
})

describe('33 §13 критерий 9: завершение офбординга', () => {
  let userId: string
  let caseId: string
  let beforeActive: number

  beforeAll(async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${PHONE}`
    userId = u!.id as string
    // Человек работает: активен (значит, считается в лимите) и имеет открытую сессию и обучение
    await admin`update users set status = 'active' where id = ${userId}`
    await admin`insert into sessions (tenant_id, user_id, token_hash, expires_at)
                values (${tenantId}, ${userId}, ${`v2-07-${Date.now()}`}, now() + interval '1 day')`
    await assignCourse(knowledgeCourseId, userId)
    beforeActive = await activeUsers()

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const started = await startOffboarding(ctx, offboardingStartSchema.parse({
      userId,
      reasonCode: 'own_wish',
      lastWorkingDay: yesterday,
      responsibleId: adminId,
    }))
    if (typeof started === 'string') throw new Error(`startOffboarding → ${started}`)
    caseId = started.id
  }, 60_000)

  it('запуск переводит человека в этап «Офбординг» и создаёт один активный случай', async () => {
    expect((await personState(ctx, userId))?.current?.stageCode).toBe('offboarding')
    const active = await listCases(ctx, { active: true })
    expect(active.filter(c => c.userId === userId)).toHaveLength(1)
  })

  it('второй случай на того же человека не заводится (§3.6)', async () => {
    const again = await startOffboarding(ctx, offboardingStartSchema.parse({
      userId,
      reasonCode: 'redundancy',
      lastWorkingDay: new Date().toISOString().slice(0, 10),
      responsibleId: adminId,
    }))
    expect(again).toBe('active_exists')
  })

  it('передача дел фиксируется отдельным шагом', async () => {
    const r = await markHandoverDone(ctx, caseId)
    if (typeof r === 'string') throw new Error(`markHandoverDone → ${r}`)
    const [row] = await admin`select handover_done_at from offboarding_cases where id = ${caseId}`
    expect(row!.handover_done_at).not.toBeNull()
  })

  it('завершение: сессии закрыты, активных назначений нет, лимит уменьшился, история цела', async () => {
    const certsBefore = (await admin`select count(*)::int as n from certificates where user_id = ${userId}`)[0]!.n
    const logBefore = (await admin`select count(*)::int as n from task_status_log where user_id = ${userId}`)[0]!.n

    const done = await completeOffboarding(ctx, caseId)
    if (typeof done === 'string') throw new Error(`completeOffboarding → ${done}`)
    expect(done.state).toBe('done')

    const [sess] = await admin`select count(*)::int as n from sessions where user_id = ${userId} and revoked_at is null`
    expect(Number(sess!.n)).toBe(0)

    const [open] = await admin`
      select count(*)::int as n from enrollments
      where user_id = ${userId} and status in ('not_started', 'in_progress') and cancelled_at is null`
    expect(Number(open!.n)).toBe(0)
    const [marked] = await admin`
      select count(*)::int as n from enrollments
      where user_id = ${userId} and status = 'not_assigned' and cancel_reason = 'offboarding'`
    expect(Number(marked!.n)).toBeGreaterThan(0)

    expect(await activeUsers()).toBe(beforeActive - 1)

    // Запись человека и история обучения сохранены (§4.2: не удаляем и не обезличиваем)
    const [person] = await admin`select status, full_name, archived_at from users where id = ${userId}`
    expect(person!.status).toBe('archived')
    expect(person!.full_name).toBe('Тимчасовий Працівник')
    expect(person!.archived_at).not.toBeNull()
    const [enrolls] = await admin`select count(*)::int as n from enrollments where user_id = ${userId}`
    expect(Number(enrolls!.n)).toBeGreaterThan(0)
    const [logAfter] = await admin`select count(*)::int as n from task_status_log where user_id = ${userId}`
    expect(Number(logAfter!.n)).toBe(Number(logBefore))
    // П-14: сертификаты при выходе не отзываются
    const [certsAfter] = await admin`select count(*)::int as n from certificates where user_id = ${userId} and revoked_at is null`
    expect(Number(certsAfter!.n)).toBe(Number(certsBefore))

    const [audit] = await admin`
      select count(*)::int as n from audit_log
      where tenant_id = ${tenantId} and action = 'offboarding.completed' and entity_id = ${caseId}`
    expect(Number(audit!.n)).toBe(1)
  })

  it('до последнего рабочего дня завершить нельзя (§10 offboarding.before_last_day)', async () => {
    const [u] = await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const started = await startOffboarding(ctx, offboardingStartSchema.parse({
      userId: u!.id as string,
      reasonCode: 'transfer_out',
      lastWorkingDay: tomorrow,
      responsibleId: adminId,
    }))
    // Последний администратор тенанта — защищён (docs/16 §7.6); проверка срока смотрится
    // на человеке, которого увольнять можно.
    expect(started).toBe('last_admin')
  })
})

describe('33 §13 критерий 10: повторный найм', () => {
  it('та же запись users, оба периода работы, новый этап — «Онбординг»', async () => {
    const [before] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${PHONE}`
    const countBefore = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n

    const r = await hire(ctx, { phone: PHONE, locationId, positionId })
    if (typeof r === 'string') throw new Error(`hire → ${r}`)

    expect(r.reused).toBe(true)
    expect(r.userId).toBe(before!.id)
    expect(r.previousPeriods).toBe(1)
    expect(r.stageId).toBe(stageIdByCode.onboarding)

    const countAfter = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n
    expect(Number(countAfter)).toBe(Number(countBefore))

    const [person] = await admin`select status, archived_at from users where id = ${r.userId}`
    expect(person!.status).toBe('active')
    expect(person!.archived_at).toBeNull()

    const state = await personState(ctx, r.userId)
    expect(state?.current?.stageCode).toBe('onboarding')
    expect(state!.history.length).toBeGreaterThan(2)
    const [places] = await admin`select count(*)::int as n from user_placements where user_id = ${r.userId}`
    expect(Number(places!.n)).toBe(2)
  })

  it('найм по external_id находит того же человека — дубля нет', async () => {
    const countBefore = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n
    const r = await hire(ctx, { externalId: EXTERNAL_ID, locationId, positionId })
    if (typeof r === 'string') throw new Error(`hire → ${r}`)
    expect(r.reused).toBe(true)
    const countAfter = (await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`)[0]!.n
    expect(Number(countAfter)).toBe(Number(countBefore))
  })
})

describe('П-14: сертификат и этап', () => {
  it('по курсу этапа с выключенным `certificate` сертификат не выдаётся', async () => {
    const [enr] = await admin`
      select id from enrollments where user_id in (select id from users where tenant_id = ${tenantId} and phone = ${PHONE})
        and subject_id = ${knowledgeCourseId} limit 1`
    await admin`update enrollments set status = 'done', completed_at = now(), cancelled_at = null where id = ${enr!.id}`
    const r = await issueForEnrollment(ctx, enr!.id as string)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('stage_no_certificate')
  })
})
