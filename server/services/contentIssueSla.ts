import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { assignTx, leastLoaded } from './contentIssueRouting'
import { issueCardUrl, notifyAssignee, scopeHolders } from './contentIssueNotify'
import { enqueueNotification } from './notifications'
import { managerIdOf } from './orgManager'
import { ACTIVE_EMPLOYEES_ONLY } from './repo/people'
import { OPEN_STATUSES, overdueDays, overdueStepsReached } from '../../shared/domain/contentIssues'
import type { OverdueStep } from '../../shared/domain/contentIssues'

/**
 * Срок жалобы и эскалация — задача `content_issue.sla_scan`, ежечасно
 * (docs/v2/36-content-feedback.md §7.6, §8 `content_issue_overdue`, §11).
 *
 * Срок `due_at` ставится при подаче (`dueAtFor`: 2 рабочих дня `blocking`, 7 — `normal`,
 * 30 — `cosmetic`; у архивного материала срока нет) и при «Відкласти» (дата, до которой
 * отложено). Скан смотрит на открытые карточки (`new`, `in_progress`, `deferred`) с истёкшим
 * сроком и проходит три ступени:
 *   - **1 день** — напоминание ответственному;
 *   - **3 дня** — его руководителю (`managerIdOf`, одна точка правды В-7);
 *   - **7 дней** — администраторам очереди (`content_issue.assign`) и переназначение по
 *     §7.5 (д): наименее загруженному носителю `content_issue.triage`, кроме текущего.
 *
 * Каждая ступень — один раз на срок: отметка — ключ дедупликации уведомления
 * `content_issue_overdue:<карточка>:<срок>:<ступень>:<кому>` и, для переназначения, событие
 * `assigned` с `reason = 'overdue'` и тем же сроком. Новый срок («Відкласти» ещё раз) —
 * новая цепочка. Ступень без адресата (нет руководителя, нет действующих администраторов)
 * не отмечается и повторяется следующим часом: появится адресат — получит.
 *
 * Уволенные и заблокированные адресатами не бывают (`ACTIVE_EMPLOYEES_ONLY`): их карточки
 * забирает ежесуточный `content_issue.reassign_scan`.
 */

const OPEN = sql.raw(OPEN_STATUSES.map(s => `'${s}'`).join(', '))

export interface SlaScanResult { reminded: number, escalated: number, reassigned: number }

interface Overdue { id: string, title: string, assignee_id: string | null, due_at: Date }

/** Ступень уже отправлена кому-то по этому сроку — повторно не шлём. */
async function stepSent(tx: TenantTx, issueId: string, dueKey: string, step: OverdueStep): Promise<boolean> {
  const [r] = await tx.execute(sql`
    select 1 from notifications
     where code = 'content_issue_overdue' and ref_id = ${issueId}::uuid
       and dedup_key like ${`content_issue_overdue:${issueId}:${dueKey}:${step}:%`}
     limit 1`) as unknown as unknown[]
  return !!r
}

async function isActive(tx: TenantTx, userId: string): Promise<boolean> {
  const [r] = await tx.execute(sql`select 1 from users u where u.id = ${userId}::uuid ${ACTIVE_EMPLOYEES_ONLY('u')}`) as unknown as unknown[]
  return !!r
}

async function send(tx: TenantTx, tenantId: string, i: Overdue, dueKey: string, step: OverdueStep, to: string[], days: number): Promise<number> {
  let n = 0
  for (const userId of to) {
    if (await enqueueNotification(tx, {
      tenantId, userId, code: 'content_issue_overdue',
      payload: { title: i.title, days, url: issueCardUrl(i.id) },
      dedupKey: `content_issue_overdue:${i.id}:${dueKey}:${step}:${userId}`,
      refType: 'content_issue', refId: i.id,
    })) n++
  }
  return n
}

export async function contentIssueSlaScan(tenantId: string, now: Date = new Date()): Promise<SlaScanResult> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select i.id, i.title, i.assignee_id, i.due_at from content_issues i
       where i.status in (${OPEN}) and i.due_at is not null
         and i.due_at <= ${now.toISOString()}::timestamptz - interval '1 day'
       order by i.due_at`) as unknown as (Omit<Overdue, 'due_at'> & { due_at: Date | string })[]

    const out: SlaScanResult = { reminded: 0, escalated: 0, reassigned: 0 }
    for (const row of rows) {
      const i: Overdue = { ...row, due_at: new Date(row.due_at) }
      const dueKey = String(i.due_at.getTime())
      const days = overdueDays(i.due_at, now)
      for (const step of overdueStepsReached(i.due_at, now)) {
        if (await stepSent(tx, i.id, dueKey, step)) continue
        if (step === 1) {
          const to = i.assignee_id && await isActive(tx, i.assignee_id) ? [i.assignee_id] : []
          out.reminded += await send(tx, tenantId, i, dueKey, step, to, days)
        }
        else if (step === 3) {
          const manager = i.assignee_id ? await managerIdOf(tx, i.assignee_id) : null
          const to = manager && manager !== i.assignee_id && await isActive(tx, manager) ? [manager] : []
          out.escalated += await send(tx, tenantId, i, dueKey, step, to, days)
        }
        else {
          out.escalated += await send(tx, tenantId, i, dueKey, step, await scopeHolders(tx, 'content_issue.assign'), days)
          if (await reassignOverdue(tx, tenantId, i, dueKey)) out.reassigned++
        }
      }
    }
    return out
  })
}

/**
 * Ступень 7 (§7.6): «з переназначенням по §7.5 (д)» — наименее загруженному носителю
 * `content_issue.triage`, кроме того, у кого карточка пролежала неделю. Один раз на срок;
 * если отдать некому — карточка остаётся на месте.
 */
async function reassignOverdue(tx: TenantTx, tenantId: string, i: Overdue, dueKey: string): Promise<boolean> {
  const [done] = await tx.execute(sql`
    select 1 from content_issue_events
     where issue_id = ${i.id}::uuid and kind = 'assigned'
       and payload->>'reason' = 'overdue' and payload->>'due_at' = ${dueKey}
     limit 1`) as unknown as unknown[]
  if (done) return false
  const to = await leastLoaded(tx, { scope: 'content_issue.triage' }, new Set(i.assignee_id ? [i.assignee_id] : []))
  if (!to) return false
  await assignTx(tx, tenantId, i.id, to, { actorId: null, from: i.assignee_id, step: 'least_loaded', overdueDueAt: dueKey })
  await recordAudit(tx, {
    tenantId, actorId: null, action: 'content_issue.overdue_reassign', entity: 'content_issue', entityId: i.id,
    before: { assigneeId: i.assignee_id }, after: { assigneeId: to, dueAt: i.due_at.toISOString() },
  })
  await notifyAssignee(tx, tenantId, i.id, 'content_issue_created')
  return true
}
