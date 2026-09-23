import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PARAM_KEYS_BY_CONTENT_TYPE, assignmentCreateSchema } from '../../shared/schemas/assignments'

/**
 * PR-06 пакета `docs/v2` (`45-plan.md`): возможности этапа фильтруют ключи `params` назначения
 * (`39-patches.md` П-15, `33-lifecycle.md` §7.5).
 *
 * Что проверяется:
 * - критерий приёмки `33` §13 п. 1 — у курса этапа «База знань» в сохранённом `params` нет
 *   ключей срока, попыток и проходного балла, и форма их не показывает;
 * - п. 3 — курс без этапа ведёт себя ровно как до пакета: доступны все ключи типа контента;
 * - п. 4 — у этапа «Психологічні тести» нет оценки и нет влияния на рейтинг: ни `passScore`,
 *   ни `points` в `params` не попадают;
 * - §7.4 (инвариант 1) — смена этапа курса не переписывает уже созданные назначения;
 * - сквозная проверка 14 (`42-stages-delta.md` §5): по всей базе ноль ключей выключенных
 *   возможностей.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createAssignment, updateAssignment } = await import('../../server/services/assignments')
const { getTaskParams, putTaskParams } = await import('../../server/services/tasks')
const { PARAM_KEY_CAPABILITY, stageParamKeys, stageParamsFor, subjectStage } = await import('../../server/services/taskParams')
const { setCourseStage } = await import('../../server/services/lifecycle')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let courseId: string
let ctx: { tenantId: string, actorId: string }
const stageIdByCode: Record<string, string> = {}
const created: string[] = []

/** Назначение-черновик на один курс: раскрытия аудитории не происходит, проверяем только `params`. */
async function assign(params: Record<string, unknown>) {
  const input = assignmentCreateSchema.parse({
    subjectType: 'course',
    subjectId: courseId,
    audience: { rules: [{ type: 'user', ids: [adminId] }], match: 'any' },
    status: 'draft',
    params,
  })
  const r = await createAssignment(ctx, input)
  if (!r.ok) throw new Error(`createAssignment → ${r.code}`)
  created.push(r.assignmentId)
  const [row] = await admin`select params from assignments where id = ${r.assignmentId}`
  return { id: r.assignmentId, params: row!.params as Record<string, unknown> }
}

/**
 * Ключи, которыми распоряжаются возможности этапа **и** которые вообще бывают у курса.
 * `attemptsAllowed`/`attemptCooldownMin` сюда не попадают: этап есть только у курса (`33` §3.4),
 * а у курса нет спроб ни при каком этапе — их режет фильтр по типу контента. Что возможность
 * `attempts` действующая, проверяется ниже на типе, у которого спроби есть.
 */
const GOVERNED = Object.keys(PARAM_KEY_CAPABILITY).filter(k => (PARAM_KEYS_BY_CONTENT_TYPE.course as readonly string[]).includes(k))
/** Значения для каждого управляемого ключа — чтобы «не сохранилось» отличалось от «не передали». */
const SAMPLE: Record<string, unknown> = {
  deadlineMode: 'days_from_assign',
  timeLimitSec: 1800,
  resultSource: 'best',
  passScore: 85,
  fixResult: true,
  scaleId: null,
  certificateId: null,
  points: 50,
}

async function setStage(code: string | null) {
  await admin`update courses set lifecycle_stage_id = ${code ? stageIdByCode[code]! : null}, stage_locked = false where id = ${courseId}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  ctx = { tenantId, actorId: adminId }
  courseId = (await admin`select id from courses where tenant_id = ${tenantId} and deleted_at is null order by created_at limit 1`)[0]!.id as string
  for (const r of await admin`select id, code from lifecycle_stages where tenant_id = ${tenantId}`) {
    stageIdByCode[r.code as string] = r.id as string
  }
}, 60_000)

afterAll(async () => {
  if (created.length) {
    await admin`delete from audit_log where entity = 'assignment' and entity_id in ${admin(created)}`
    await admin`delete from assignments where id in ${admin(created)}`
  }
  await admin`update courses set lifecycle_stage_id = null, stage_locked = false where id = ${courseId}`
  await admin.end()
})

describe('33 §13 критерий 3: курс без этапа — поведение базового ТЗ', () => {
  beforeAll(() => setStage(null))

  it('доступны все ключи, которые допускает тип контента', async () => {
    const stage = await withTenant(tenantId, adminId, tx => subjectStage(tx, 'course', courseId))
    expect(stage).toBeNull()
    expect(stageParamKeys('course', stage)).toEqual([...PARAM_KEYS_BY_CONTENT_TYPE.course])
  })

  it('назначение сохраняет срок, порог и награды — ничего не отброшено', async () => {
    const { params } = await assign({ deadlineMode: 'days_from_assign', passScore: 85, points: 50, certificateId: null })
    expect(params.deadlineMode).toBe('days_from_assign')
    expect(params.passScore).toBe(85)
    expect(params.points).toBe(50)
  })
})

describe('33 §13 критерий 1: курс этапа «База знань»', () => {
  beforeAll(() => setStage('knowledge'))

  it('в сохранённом params нет ни срока, ни попыток, ни проходного балла', async () => {
    const { params } = await assign(SAMPLE)
    for (const key of GOVERNED) expect(params, key).not.toHaveProperty(key)
  })

  it('ключ не сохраняется вовсе — а не со значением по умолчанию (П-15)', async () => {
    const { params } = await assign({ deadlineMode: 'unlimited', passScore: 1 })
    expect(Object.keys(params)).not.toContain('deadlineMode')
    expect(Object.keys(params)).not.toContain('passScore')
  })

  it('возможность attempts действует на типе, у которого спроби есть', async () => {
    const stage = await withTenant(tenantId, adminId, tx => subjectStage(tx, 'course', courseId))
    expect(stageParamKeys('test', stage)).not.toContain('attemptsAllowed')
    expect(stageParamKeys('test', null)).toContain('attemptsAllowed')
  })

  it('в форме назначения этих полей нет: сервер не отдаёт их в paramKeys', async () => {
    const { id } = await assign({})
    const data = await getTaskParams(ctx, id)
    for (const key of GOVERNED) expect(data!.paramKeys, key).not.toContain(key)
    // Ключи, которых этап не касается, на месте — скрыта группа полей, а не вся форма
    expect(data!.paramKeys).toContain('allowComments')
    expect(data!.paramKeys).toContain('strictOrder')
  })

  it('PUT /tasks/:id/params молча отбрасывает запрещённый ключ, а не пишет его', async () => {
    const { id } = await assign({})
    const r = await putTaskParams(ctx, id, { deadlineMode: 'calendar', passScore: 60, allowComments: true })
    expect(r.ok).toBe(true)
    const [row] = await admin`select params from assignments where id = ${id}`
    expect(row!.params).toEqual({ allowComments: true })
  })

  it('updateAssignment тоже не впускает запрещённый ключ', async () => {
    const { id } = await assign({ allowComments: true })
    await updateAssignment(ctx, id, { params: { passScore: 70, notifyOnResult: true } })
    const [row] = await admin`select params from assignments where id = ${id}`
    expect(row!.params).not.toHaveProperty('passScore')
    expect(row!.params).toHaveProperty('notifyOnResult', true)
  })
})

describe('33 §13 критерий 4: «Психологічні тести» — ни оценки, ни рейтинга', () => {
  beforeAll(() => setStage('psychological'))

  it('оценка и баллы рейтинга не сохраняются, а срок — сохраняется (§3.3: deadline = true)', async () => {
    const { params } = await assign({ passScore: 80, resultSource: 'best', points: 100, deadlineMode: 'calendar' })
    expect(params).not.toHaveProperty('passScore')
    expect(params).not.toHaveProperty('resultSource')
    expect(params).not.toHaveProperty('points')
    expect(params).toHaveProperty('deadlineMode', 'calendar') // deadline = true
    // attempts = false: у теста этого этапа поля спроб тоже не будет
    const stage = await withTenant(tenantId, adminId, tx => subjectStage(tx, 'course', courseId))
    expect(stageParamKeys('test', stage)).not.toContain('attemptsAllowed')
  })
})

describe('этап с возможностью — ключ сохраняется', () => {
  beforeAll(() => setStage('onboarding'))

  it('«Онбординг» разрешает все пять групп: ключи на месте', async () => {
    const { params } = await assign({ deadlineMode: 'days_from_assign', passScore: 85, points: 50, timeLimitSec: 1800, certificateId: null })
    expect(params).toMatchObject({ deadlineMode: 'days_from_assign', passScore: 85, points: 50, timeLimitSec: 1800 })
    const stage = await withTenant(tenantId, adminId, tx => subjectStage(tx, 'course', courseId))
    expect(stageParamKeys('test', stage)).toContain('attemptsAllowed')
  })

  it('фильтр — не заглушка: у того же курса на «Базі знань» те же ключи отбрасываются', async () => {
    const allowed = await withTenant(tenantId, adminId, async tx =>
      stageParamsFor(tx, 'course', courseId, { passScore: 85, deadlineMode: 'calendar' }))
    await setStage('knowledge')
    const denied = await withTenant(tenantId, adminId, async tx =>
      stageParamsFor(tx, 'course', courseId, { passScore: 85, deadlineMode: 'calendar' }))
    await setStage('onboarding')
    expect(Object.keys(allowed).sort()).toEqual(['deadlineMode', 'passScore'])
    expect(Object.keys(denied)).toEqual([])
  })
})

describe('33 §7.4 (инвариант 1): смена этапа курса не переписывает созданные назначения', () => {
  it('назначение, созданное на «Онбордингу», сохраняет свои params после перевода курса на «Базу знань»', async () => {
    await setStage('onboarding')
    const { id, params } = await assign({ deadlineMode: 'days_from_assign', passScore: 85, points: 50 })
    expect(params).toMatchObject({ deadlineMode: 'days_from_assign', passScore: 85, points: 50 })

    const moved = await setCourseStage(ctx, courseId, stageIdByCode.knowledge!, true)
    expect(typeof moved === 'string' ? moved : moved.lifecycleStageId).toBe(stageIdByCode.knowledge)

    const [row] = await admin`select params from assignments where id = ${id}`
    expect(row!.params).toMatchObject({ deadlineMode: 'days_from_assign', passScore: 85, points: 50 })

    // Чтение тоже не режет сохранённое — иначе «не пересчитываются» превратилось бы в «не видно»
    const data = await getTaskParams(ctx, id)
    expect(data!.params).toMatchObject({ deadlineMode: 'days_from_assign', passScore: 85 })
    // Но форма новых полей уже не предложит: новые правила действуют на новые записи
    expect(data!.paramKeys).not.toContain('deadlineMode')
  })
})

describe('42 §5, сквозная проверка 14: выключенная возможность не лежит в params', () => {
  /**
   * SQL проверки приведён к действительности репозитория и к правилу §7.4.
   *
   * 1. Имена. `42` §5 написан по черновику схемы: `a.course_id` и ключи `deadline_mode`,
   *    `attempts_max`, `pass_score`. В коде носитель назначения — пара
   *    (`subject_type`, `subject_id`), а ключи `params` — camelCase (`docs/28` §«assignments.params»).
   *    Пары «ключ → возможность» берутся из `PARAM_KEY_CAPABILITY`, а не переписываются в SQL
   *    руками: иначе проверка и фильтр разойдутся молча.
   * 2. Окно. Дословная формулировка «ноль строк по всей базе» противоречит §7.4: уже созданные
   *    назначения при смене этапа курса **не пересчитываются**, и законно сохранившийся
   *    `deadlineMode` курса, переехавшего на «Базу знань», дал бы «нарушение». Проверяется то,
   *    что и предписано П-15, — **запись**: назначения, записанные после последней смены этапа
   *    своего курса (`audit_log`, `course.stage_changed`).
   */
  const violations = () => admin`
    select a.id, s.code, k.key
    from assignments a
    join courses c on c.id = a.subject_id and a.subject_type = 'course'
    join lifecycle_stages s on s.id = c.lifecycle_stage_id
    cross join lateral jsonb_object_keys(a.params) as k(key)
    join (values ${admin(Object.entries(PARAM_KEY_CAPABILITY).map(([key, cap]) => [key, cap]))}) as m(key, capability)
      on m.key = k.key
    left join lateral (
      select max(created_at) as at from audit_log
      where entity = 'courses' and entity_id = c.id and action = 'course.stage_changed') sc on true
    where (s.capabilities ->> m.capability) is distinct from 'true'
      and (sc.at is null or a.updated_at >= sc.at)`

  it('ноль строк: ни одно назначение не записало ключ выключенной возможности', async () => {
    expect((await violations()).map(r => `${r.code}.${r.key}`)).toEqual([])
  })

  it('проверка не тавтология: ключ, вписанный мимо сервиса, она находит', async () => {
    await setStage('knowledge')
    const { id } = await assign({})
    await admin`update assignments set params = '{"passScore": 50}'::jsonb, updated_at = now() where id = ${id}`
    expect((await violations()).map(r => `${r.code}.${r.key}`)).toEqual(['knowledge.passScore'])
    await admin`update assignments set params = '{}'::jsonb where id = ${id}`
    expect(await violations()).toEqual([])
  })
})
