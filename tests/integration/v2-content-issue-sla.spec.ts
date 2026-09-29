import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `content_issue.sla_scan` (docs/v2/36-content-feedback.md §7.6, §8 `content_issue_overdue`,
 * §11): просрочка 1 день — ответственному, 3 — его руководителю, 7 — администраторам очереди
 * с переназначением по §7.5 (д). Каждая ступень — один раз на срок; новый срок — новая цепочка.
 * Плюс «Мої повідомлення» (§5.5): свои жалобы со статусом простыми словами.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { submitReport, myReports } = await import('../../server/services/contentIssues')
const { contentIssueSlaScan } = await import('../../server/services/contentIssueSla')
const { updateIssue } = await import('../../server/services/contentIssueTriage')
const { managerIdOf } = await import('../../server/services/orgManager')
const { createResource, publishResource } = await import('../../server/services/resources')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const TAG = `sla-${Date.now()}`
const DAY = 86_400_000

let tenantId: string
let adminId: string
let authorId: string
let mentorId: string
let employeeId: string
let locationId: string
let oldManager: string | null
const resourceIds: string[] = []

const ctx = (actorId: string) => ({ tenantId, actorId })
const adminV = () => ({ tenantId, actorId: adminId, canTriage: true, isAdmin: true, canRescore: true, visibility: 'all' as const })

async function cleanup() {
  await admin`delete from content_issue_events where tenant_id = ${tenantId}`
  await admin`delete from content_reports where tenant_id = ${tenantId}`
  await admin`update attempt_results set issue_id = null where tenant_id = ${tenantId} and issue_id is not null`
  await admin`delete from content_issues where tenant_id = ${tenantId}`
  await admin`delete from content_reporter_stats where tenant_id = ${tenantId}`
  await admin`delete from content_issue_routing_rules where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and (code like 'content_issue%' or code like 'content_reporter%')`
  await admin`delete from audit_log where tenant_id = ${tenantId} and action = 'content_issue.overdue_reassign'`
}

async function newIssue(title: string, issueType: 'unclear' | 'typo' = 'unclear'): Promise<string> {
  const r = await createResource(ctx(adminId), { kind: 'article', title: `${TAG} ${title}`, language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [{ id: 'b1', type: 'text' as const, html: '<p>Текст</p>' }], authorIds: [authorId] })
  resourceIds.push(r.id)
  const p = await publishResource(ctx(adminId), r.id, { notifyAssigned: false })
  if (!p.ok) throw new Error(`publishResource: ${p.code}`)
  const s = await submitReport(ctx(employeeId), { targetType: 'resource', targetId: r.id, issueType, source: 'lesson', context: {} }, { exemptFromLimits: true })
  if (!s.ok) throw new Error(`submitReport: ${JSON.stringify(s)}`)
  return s.result.issueId
}

const overdue = (issueId: string) => admin`
  select user_id, payload, dedup_key from notifications
   where ref_id = ${issueId} and code = 'content_issue_overdue' order by created_at, dedup_key`

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  authorId = await pick('+380670000001')
  mentorId = await pick('+380670000002')
  employeeId = await pick('+380670000003')
  await cleanup()
  // Руководитель автора — руководитель его точки (docs/v2/31 В-7): ставим на время спеки
  const [pl] = await admin`
    select up.location_id, l.manager_id from user_placements up join locations l on l.id = up.location_id
     where up.user_id = ${authorId} order by up.is_primary desc limit 1`
  locationId = pl!.location_id as string
  oldManager = (pl!.manager_id as string | null) ?? null
  await admin`update locations set manager_id = ${mentorId} where id = ${locationId}`
})

afterAll(async () => {
  await cleanup()
  await admin`update locations set manager_id = ${oldManager} where id = ${locationId}`
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  await admin.end()
})

describe('content_issue.sla_scan: ступени 1/3/7 (§7.6)', () => {
  let issueId: string
  const due = new Date('2026-09-01T09:00:00Z')

  it('руководитель автора определяется (предусловие ступени 3)', async () => {
    expect(await withTenant(tenantId, null, tx => managerIdOf(tx, authorId))).toBe(mentorId)
  })

  it('до истечения суток после срока — ничего', async () => {
    issueId = await newIssue('Прострочена скарга')
    expect((await admin`select assignee_id from content_issues where id = ${issueId}`)[0]!.assignee_id).toBe(authorId)
    await admin`update content_issues set due_at = ${due} where id = ${issueId}`
    const s = await contentIssueSlaScan(tenantId, new Date(due.getTime() + 20 * 3_600_000))
    expect(s).toEqual({ reminded: 0, escalated: 0, reassigned: 0 })
    expect(await overdue(issueId)).toHaveLength(0)
  })

  it('1 день — напоминание ответственному, повторный прогон не дублирует', async () => {
    const now = new Date(due.getTime() + DAY + 3_600_000)
    expect((await contentIssueSlaScan(tenantId, now)).reminded).toBe(1)
    const rows = await overdue(issueId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(authorId)
    expect(rows[0]!.payload).toMatchObject({ days: 1, url: `/admin/content-issues/${issueId}` })
    expect(await contentIssueSlaScan(tenantId, new Date(now.getTime() + 3_600_000))).toEqual({ reminded: 0, escalated: 0, reassigned: 0 })
  })

  it('3 дня — руководителю ответственного; первая ступень не повторяется', async () => {
    const s = await contentIssueSlaScan(tenantId, new Date(due.getTime() + 3 * DAY + 60_000))
    expect(s).toEqual({ reminded: 0, escalated: 1, reassigned: 0 })
    const rows = await overdue(issueId)
    expect(rows.map(r => r.user_id)).toEqual([authorId, mentorId])
    expect(rows[1]!.payload).toMatchObject({ days: 3 })
  })

  it('7 дней — администраторам и переназначение наименее загруженному разбирающему, один раз', async () => {
    const now = new Date(due.getTime() + 7 * DAY + 60_000)
    const s = await contentIssueSlaScan(tenantId, now)
    expect(s.escalated).toBeGreaterThanOrEqual(1)
    expect(s.reassigned).toBe(1)
    const rows = await overdue(issueId)
    expect(rows.filter(r => (r.dedup_key as string).includes(':7:')).map(r => r.user_id)).toContain(adminId)
    // Автор (текущий) исключён; из носителей `content_issue.triage` остаётся администратор
    const [i] = await admin`select assignee_id from content_issues where id = ${issueId}`
    expect(i!.assignee_id).toBe(adminId)
    const [ev] = await admin`select actor_id, payload from content_issue_events where issue_id = ${issueId} and kind = 'assigned' and payload->>'reason' = 'overdue'`
    expect(ev!.actor_id).toBeNull()
    expect(ev!.payload).toMatchObject({ from: authorId, to: adminId, step: 'least_loaded', due_at: String(due.getTime()) })
    const [au] = await admin`select * from audit_log where entity_id = ${issueId} and action = 'content_issue.overdue_reassign'`
    expect(au).toBeTruthy()
    const [created] = await admin`select user_id from notifications where ref_id = ${issueId} and code = 'content_issue_created' and user_id = ${adminId}`
    expect(created).toBeTruthy()
    // Повтор через час: ни уведомлений, ни второго переназначения
    expect(await contentIssueSlaScan(tenantId, new Date(now.getTime() + 3_600_000))).toEqual({ reminded: 0, escalated: 0, reassigned: 0 })
  })

  it('новый срок («Відкласти») — новая цепочка, напоминание новому ответственному', async () => {
    const r = await updateIssue(adminV(), issueId, { status: 'deferred', dueAt: '2026-12-01' })
    expect(r.ok).toBe(true)
    const [i] = await admin`select due_at from content_issues where id = ${issueId}`
    const due2 = new Date(i!.due_at as Date)
    expect(await contentIssueSlaScan(tenantId, new Date(due.getTime() + 8 * DAY))).toEqual({ reminded: 0, escalated: 0, reassigned: 0 })
    const s = await contentIssueSlaScan(tenantId, new Date(due2.getTime() + DAY + 60_000))
    expect(s.reminded).toBe(1)
    const last = (await overdue(issueId)).filter(x => (x.dedup_key as string).includes(`:${due2.getTime()}:1:`))
    expect(last.map(x => x.user_id)).toEqual([adminId])
  })

  it('закрытые, отклонённые и карточки без срока скан не трогает', async () => {
    const rejected = await newIssue('Відхилена скарга', 'typo')
    await admin`update content_issues set status = 'rejected', resolution = 'not_an_error', resolution_comment = 'Перевірили: помилки немає', due_at = ${due} where id = ${rejected}`
    const noDue = await newIssue('Скарга без терміну', 'typo')
    await admin`update content_issues set due_at = null where id = ${noDue}`
    await contentIssueSlaScan(tenantId, new Date(due.getTime() + 10 * DAY))
    expect(await overdue(rejected)).toHaveLength(0)
    expect(await overdue(noDue)).toHaveLength(0)
  })

  it('ответственный заблокирован — напоминания нет и ступень не отмечена', async () => {
    const id = await newIssue('Скарга заблокованого', 'typo')
    await admin`update content_issues set due_at = ${due}, assignee_id = ${employeeId} where id = ${id}`
    await admin`update users set is_blocked = true where id = ${employeeId}`
    try {
      const s = await contentIssueSlaScan(tenantId, new Date(due.getTime() + DAY + 60_000))
      expect(s.reminded).toBe(0)
      expect(await overdue(id)).toHaveLength(0)
    }
    finally {
      await admin`update users set is_blocked = false where id = ${employeeId}`
    }
  })
})

describe('«Мої повідомлення про помилки» (§5.5)', () => {
  it('только свои жалобы, со статусом простыми словами и ответом автора', async () => {
    const mine = await myReports(ctx(employeeId))
    expect(mine.length).toBeGreaterThanOrEqual(3)
    const rejected = mine.find(r => r.title.includes('Відхилена скарга'))!
    expect(rejected.reporterStatus).toBe('not_confirmed')
    expect(rejected.resolutionComment).toBe('Перевірили: помилки немає')
    const deferred = mine.find(r => r.title.includes('Прострочена скарга'))!
    expect(deferred.reporterStatus).toBe('reviewing')
    // Внутренние поля карточки заявителю не отдаются
    expect(Object.keys(deferred)).not.toContain('assigneeId')
    expect(await myReports(ctx(mentorId))).toEqual([])
  })
})
