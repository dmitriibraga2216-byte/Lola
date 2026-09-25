import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * docs/28 §28.9.1 п.1 (решение владельца 25.09): кандидат в строке журнала (`server/services/logs.ts`)
 * виден только смотрящему с правом `candidate.view` — без права строка про кандидата скрыта,
 * остаются только сотрудники (CLAUDE.md инвариант 17). Условие созрело с #106/#109: кандидат
 * проходит курс і тест вакансії, отримує сповіщення і входить у систему, і «Протокол змін
 * статусу», «Звернення до завдань», журнали сповіщень і сесій показували його ПІБ, IP і гео
 * будь-кому з `audit.view` — без різниці видів (докладніше — відкрите питання, яке цей тест
 * закриває). Журнал `security` рішення не торкається: вхід кандидата лишається видимим цілком
 * тому, у кого є право на сам журнал (`audit.view`) — це потрібно для розслідувань.
 *
 * Канарейка — «Канарка Перша» з посіву (той самий кандидат, що і в
 * `tests/integration/reports-kind.spec.ts`). Штатний контроль — свіжий співробітник цього тесту,
 * не людина посіву (чужий тест міг перевести його в інший вид або заархівувати). У кожному
 * журналі, де рядок прив'язаний до людини через `frameSelect()` (`task-status`, `task-access`,
 * `org-conflicts`, `notifications`, `sessions`, `automation`), в обох є рядок — клас помилок, а
 * не перелічені випадки, так само як `reports-kind.spec.ts` проганяє всі сутності конструктора.
 * `security` перевіряється окремо: тільки вхід кандидата, фільтр вида на нього не діє.
 */

const { readLog } = await import('../../server/services/logs')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const CANARY = 'Канарка Перша'
const STAFF = 'Штатна Контрольна (журнали)'

/** Журналы, где `u` — человек строки (frameSelect); `security` не включён — решение владельца его не сужает. */
const GATED_KINDS = ['task-status', 'task-access', 'org-conflicts', 'notifications', 'sessions', 'automation'] as const

let tenantId: string, actorId: string, canaryId: string, staffId: string, ruleId: string
let orphanConflictId: string, securityLogId: string
const passEventIds: string[] = []
const taskAccessIds: string[] = []
const notificationIds: string[] = []
const sessionIds: string[] = []
const orgConflictIds: string[] = []
const automationRunIds: string[] = []

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  actorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [canary] = await admin`select id from users where tenant_id = ${tenantId} and full_name = ${CANARY} and kind = 'candidate'`
  if (!canary) throw new Error(`канареечный кандидат «${CANARY}» не найден — нужен \`pnpm db:seed\` на чистой базе`)
  canaryId = canary.id as string
  // Свой сотрудник, а не человек посева: чужой тест мог его заархивировать или перевести.
  const phone = `+38065${String(Date.now()).slice(-7)}`
  staffId = (await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${STAFF}, 'active') returning id`)[0]!.id as string

  const [rule] = await admin`insert into automation_rules (tenant_id, name, trigger) values (${tenantId}, 'kind-gate probe', 'user.created') returning id`
  ruleId = rule!.id as string

  for (const userId of [canaryId, staffId]) {
    const [pe] = await admin`
      insert into pass_events (tenant_id, subject_type, subject_id, enrollment_id, user_id, event)
      values (${tenantId}, 'training_program', gen_random_uuid(), gen_random_uuid(), ${userId}, 'created')
      returning id`
    passEventIds.push(pe!.id as string)
    const [ta] = await admin`
      insert into task_access_log (tenant_id, user_id, content_type, content_id)
      values (${tenantId}, ${userId}, 'course', gen_random_uuid())
      returning id`
    taskAccessIds.push(ta!.id as string)
    const [n] = await admin`
      insert into notifications (tenant_id, user_id, code, channel)
      values (${tenantId}, ${userId}, 'kind_gate_probe', 'telegram')
      returning id`
    notificationIds.push(n!.id as string)
    const [s] = await admin`
      insert into sessions (tenant_id, user_id, token_hash, expires_at)
      values (${tenantId}, ${userId}, ${`th_kind_gate_${userId}_${Date.now()}`}, now() + interval '1 day')
      returning id`
    sessionIds.push(s!.id as string)
    const [oc] = await admin`
      insert into org_conflicts (tenant_id, user_id, kind)
      values (${tenantId}, ${userId}, 'double_unit')
      returning id`
    orgConflictIds.push(oc!.id as string)
    const [ar] = await admin`
      insert into automation_runs (tenant_id, rule_id, user_id, status)
      values (${tenantId}, ${ruleId}, ${userId}, 'ok')
      returning id`
    automationRunIds.push(ar!.id as string)
  }

  // Конфликт без людини (user_id null): у org_conflicts join з users — left, людина не обов'язкова
  // (docs/16: nodeId null — «конфлікт про людину», тут навпаки — узагалі без людини й без вузла).
  // Рядок не повинен пропасти в смотрящого без candidate.view — це взагалі не про кандидата.
  const [orphan] = await admin`
    insert into org_conflicts (tenant_id, kind)
    values (${tenantId}, 'depth_exceeded')
    returning id`
  orphanConflictId = orphan!.id as string
  orgConflictIds.push(orphanConflictId)

  const [sec] = await admin`insert into security_log (tenant_id, user_id, event) values (${tenantId}, ${canaryId}, 'user.login') returning id`
  securityLogId = sec!.id as string
})

afterAll(async () => {
  if (securityLogId) await admin`delete from security_log where id = ${securityLogId}`
  if (automationRunIds.length) await admin`delete from automation_runs where id in ${admin(automationRunIds)}`
  if (ruleId) await admin`delete from automation_rules where id = ${ruleId}`
  if (orgConflictIds.length) await admin`delete from org_conflicts where id in ${admin(orgConflictIds)}`
  if (sessionIds.length) await admin`delete from sessions where id in ${admin(sessionIds)}`
  if (notificationIds.length) await admin`delete from notifications where id in ${admin(notificationIds)}`
  if (taskAccessIds.length) await admin`delete from task_access_log where id in ${admin(taskAccessIds)}`
  if (passEventIds.length) await admin`delete from pass_events where id in ${admin(passEventIds)}`
  if (staffId) await admin`delete from users where id = ${staffId}`
  await admin.end()
})

const ctxNo = () => ({ tenantId, actorId, canSeeCandidates: false })
const ctxYes = () => ({ tenantId, actorId, canSeeCandidates: true })

describe('candidate.view решает видимость кандидата в журналах (docs/28 §28.9.1 п.1, решение владельца 25.09)', () => {
  it.each(GATED_KINDS)('«%s»: у канарейки і штатного контролю є рядок — інакше перевірка нижче нічого не доведе', async (kind) => {
    const staffRows = await readLog(ctxYes(), kind, { userId: staffId, limit: 10 })
    expect(staffRows.length, `сотрудник пропал из «${kind}»`).toBeGreaterThan(0)
    const canaryRows = await readLog(ctxYes(), kind, { userId: canaryId, limit: 10 })
    expect(canaryRows.length, `кандидат пропал из «${kind}» — фикстура теста не дала ему строку`).toBeGreaterThan(0)
  })

  it.each(GATED_KINDS)('«%s»: без candidate.view виден тільки співробітник, з правом — обидва', async (kind) => {
    const staffWithout = await readLog(ctxNo(), kind, { userId: staffId, limit: 10 })
    expect(staffWithout.length, `сотрудник пропал из «${kind}» без candidate.view — фильтр перепутал вид`).toBeGreaterThan(0)
    const canaryWithout = await readLog(ctxNo(), kind, { userId: canaryId, limit: 10 })
    expect(canaryWithout.length, `кандидат виден у «${kind}» без candidate.view`).toBe(0)
    const canaryWith = await readLog(ctxYes(), kind, { userId: canaryId, limit: 10 })
    expect(canaryWith.length, `кандидат пропав із «${kind}» навіть з candidate.view`).toBeGreaterThan(0)
  })

  it('«org-conflicts»: конфлікт без людини не пропадає без candidate.view — join кандидата опційний', async () => {
    const rows = await readLog(ctxNo(), 'org-conflicts', { limit: 500 })
    expect(rows.some(r => r.id === orphanConflictId), 'безлюдний конфлікт пропав через фільтр виду (nullable join)').toBe(true)
  })

  it('«security»: вхід кандидата видно цілком незалежно від candidate.view — рішення власника цей журнал не звужує', async () => {
    const withoutCandidateView = await readLog(ctxNo(), 'security', { userId: canaryId, limit: 10 })
    expect(withoutCandidateView.some(r => r.id === securityLogId), 'вхід кандидата пропав із security при canSeeCandidates=false').toBe(true)
    const withCandidateView = await readLog(ctxYes(), 'security', { userId: canaryId, limit: 10 })
    expect(withCandidateView.some(r => r.id === securityLogId), 'вхід кандидата пропав із security при canSeeCandidates=true').toBe(true)
  })

  it('«security» лишається доступним лише по audit.view — незалежно від candidate.view', () => {
    for (const file of ['server/api/v1/security-log.get.ts', 'server/api/v1/logs/[kind].get.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', file), 'utf8')
      expect(src, `${file}: нема requireScope(event, 'audit.view')`).toMatch(/requireScope\(event,\s*'audit\.view'\)/)
    }
  })
})
