import { and, eq, inArray, sql } from 'drizzle-orm'
import { contentIssues, contentReports } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { recipientLocale } from '../utils/formatLocale'
import { enqueueNotification } from './notifications'
import { managerIdOf } from './orgManager'
import { ACTIVE_EMPLOYEES_ONLY, NOT_ARCHIVED_EMPLOYEES_ONLY } from './repo/people'
import { defaultDictionary } from './translations'
import { MERGED_NOTIFY_MAX_PER_DAY, mergedNotifyDue } from '../../shared/domain/contentIssues'
import { formatDate, formatNumber } from '../../shared/domain/dateFormat'

/**
 * Уведомления модуля жалоб (docs/v2/36-content-feedback.md §8). Ни одно не шлётся напрямую —
 * только очередью `notifications` (docs/23): журнал, дедупликация, тихие часы.
 *
 * Каналы — по таблице §8: `in-app` здесь значит «только колокольчик» (`channel: 'inapp'`
 * диспетчер не отправляет наружу), остальные коды идут основным каналом Telegram, резервным —
 * колокольчиком. Заявитель, уволенный до закрытия карточки, уведомления не получает (§12):
 * адресаты берутся из действующих сотрудников, как и в маршрутизации.
 */

type AssigneeCode = 'content_issue_created' | 'content_issue_merged' | 'content_issue_blocking'
type ReporterCode = 'content_issue_accepted' | 'content_issue_fixed' | 'content_issue_rejected'

interface Subject {
  id: string
  title: string
  issueType: string
  reportsCount: number
  assigneeId: string | null
  resolutionComment: string | null
}

async function subjectOf(tx: TenantTx, issueId: string): Promise<Subject | null> {
  const [i] = await tx.select({
    id: contentIssues.id,
    title: contentIssues.title,
    issueType: contentIssues.issueType,
    reportsCount: contentIssues.reportsCount,
    assigneeId: contentIssues.assigneeId,
    resolutionComment: contentIssues.resolutionComment,
  }).from(contentIssues).where(eq(contentIssues.id, issueId))
  return i ?? null
}

/** Подпись типа проблемы для текста уведомления: шаблоны по умолчанию — украинские (docs/23 §6.9). */
function typeLabel(code: string): string {
  return defaultDictionary('uk')[`issue.type.${code}`] ?? code
}

/** Карточка в админке — кнопка «Відкрити» у колокольчика и в Telegram (`refUrl`). */
export const issueCardUrl = (id: string) => `/admin/content-issues/${id}`

/** Действующие сотрудники из списка — адресаты работы: ответственный, администратор, руководитель. */
async function activeOf(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return []
  const rows = await tx.execute(sql`
    select u.id from users u
     where u.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}) ${ACTIVE_EMPLOYEES_ONLY('u')}`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Адресаты ответа на их же обращение — заявители и те, чей результат пересчитан: все, кроме
 * уволенных (§12: «заявитель уволен до закрытия — уведомление не отправляется»).
 */
async function notDismissedOf(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return []
  const rows = await tx.execute(sql`
    select u.id from users u
     where u.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}) ${NOT_ARCHIVED_EMPLOYEES_ONLY('u')}`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/** Действующие носители скоупа (администратор очереди, пересчёта): адресаты «admin» из §8. */
export async function scopeHolders(tx: TenantTx, scope: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select u.id from users u
     where exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                    where ur.user_id = u.id and r.scopes @> array[${scope}]::text[]
                      and (ur.valid_until is null or ur.valid_until > now()))
       ${ACTIVE_EMPLOYEES_ONLY('u')}
     order by u.id`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Ответственному (§8): `created` — новая карточка или переназначение; `blocking` — контент не
 * работает (ещё и администраторам очереди); `merged` — 3-я и каждая 5-я жалоба, не больше трёх
 * в сутки на карточку: сорок жалоб на одно видео дают три уведомления, а не сорок (§12).
 */
export async function notifyAssignee(tx: TenantTx, tenantId: string, issueId: string, code: AssigneeCode): Promise<number> {
  const s = await subjectOf(tx, issueId)
  if (!s) return 0
  const payload = { title: s.title, typeLabel: typeLabel(s.issueType), count: s.reportsCount, url: issueCardUrl(s.id) }

  if (code === 'content_issue_merged') {
    if (!s.assigneeId || !mergedNotifyDue(s.reportsCount)) return 0
    const [today] = await tx.execute(sql`
      select count(*)::int as n from notifications
       where code = 'content_issue_merged' and ref_id = ${issueId}::uuid and created_at >= current_date`) as unknown as { n: number }[]
    if ((today?.n ?? 0) >= MERGED_NOTIFY_MAX_PER_DAY) return 0
    const [to] = await activeOf(tx, [s.assigneeId])
    if (!to) return 0
    return await enqueueNotification(tx, {
      tenantId, userId: to, code, payload, channel: 'inapp',
      dedupKey: `${code}:${issueId}:${s.reportsCount}`, refType: 'content_issue', refId: issueId,
    }) ? 1 : 0
  }

  const recipients = code === 'content_issue_blocking'
    ? [...new Set([...(s.assigneeId ? [s.assigneeId] : []), ...await scopeHolders(tx, 'content_issue.assign')])]
    : s.assigneeId ? [s.assigneeId] : []
  let n = 0
  for (const userId of await activeOf(tx, recipients)) {
    if (await enqueueNotification(tx, {
      tenantId, userId, code, payload,
      dedupKey: `${code}:${issueId}:${userId}`, refType: 'content_issue', refId: issueId,
    })) n++
  }
  return n
}

/**
 * Заявителям (§8): `accepted` — взяли в работу (колокольчик), `fixed` — закрыто с
 * исправлением (Telegram), `rejected` — «Ми перевірили: …» (колокольчик). `eventId` делает
 * ключ дедупликации уникальным для перехода: переоткрытая и снова закрытая карточка
 * уведомляет повторно. Для `fixed` и `rejected` ставится `content_reports.notified_at` —
 * четвёртое условие закрытия (§7.9).
 */
export async function notifyReporters(tx: TenantTx, tenantId: string, issueId: string, code: ReporterCode, eventId: string): Promise<number> {
  const s = await subjectOf(tx, issueId)
  if (!s) return 0
  const reports = await tx.select({ id: contentReports.id, userId: contentReports.userId }).from(contentReports)
    .where(eq(contentReports.issueId, issueId))
  const active = new Set(await notDismissedOf(tx, [...new Set(reports.map(r => r.userId))]))
  const payload = { title: s.title, typeLabel: typeLabel(s.issueType), comment: s.resolutionComment ?? '' }
  let n = 0
  const notified: string[] = []
  for (const r of reports) {
    if (!active.has(r.userId)) continue
    if (await enqueueNotification(tx, {
      tenantId, userId: r.userId, code, payload,
      ...(code === 'content_issue_fixed' ? {} : { channel: 'inapp' as const }),
      dedupKey: `${code}:${issueId}:${eventId}:${r.userId}`, refType: 'content_issue', refId: issueId,
    })) n++
    notified.push(r.id)
  }
  if (code !== 'content_issue_accepted' && notified.length) {
    await tx.update(contentReports).set({ notifiedAt: new Date() })
      .where(and(eq(contentReports.issueId, issueId), inArray(contentReports.id, notified)))
  }
  return n
}

/**
 * Администраторам пересчёта (§8 `content_issue_rescore_ready`, in-app + e-mail): карточка
 * подтверждена, и попытки, где встречается вопрос, можно пересчитать.
 */
export async function notifyRescoreReady(tx: TenantTx, tenantId: string, issueId: string, attempts: number): Promise<number> {
  const s = await subjectOf(tx, issueId)
  if (!s) return 0
  let n = 0
  for (const userId of await scopeHolders(tx, 'content_issue.rescore')) {
    if (await enqueueNotification(tx, {
      tenantId, userId, code: 'content_issue_rescore_ready', channel: 'email',
      payload: { title: s.title, count: attempts, url: issueCardUrl(issueId) },
      dedupKey: `content_issue_rescore_ready:${issueId}:${userId}`, refType: 'content_issue', refId: issueId,
    })) n++
  }
  return n
}

async function localeOf(tx: TenantTx, tenantId: string, userId: string) {
  const [r] = await tx.execute(sql`
    select (select locale from users where id = ${userId}::uuid) as user_locale,
           (select locale from tenants where id = ${tenantId}::uuid) as tenant_locale`) as unknown as { user_locale: string | null, tenant_locale: string | null }[]
  return recipientLocale(r?.user_locale, r?.tenant_locale)
}

/**
 * Тем, чей результат изменился (§8 `content_issue_rescored`, критерий 5): старый и новый балл.
 * Числа форматируются локалью получателя (`formatNumber`), а не `String()`.
 */
export async function notifyRescored(
  tx: TenantTx,
  tenantId: string,
  issueId: string,
  changed: { userId: string, attemptId: string, scoreBefore: number | null, scoreAfter: number }[],
): Promise<number> {
  const s = await subjectOf(tx, issueId)
  let n = 0
  const active = new Set(await notDismissedOf(tx, [...new Set(changed.map(c => c.userId))]))
  for (const c of changed) {
    if (!active.has(c.userId)) continue
    const locale = await localeOf(tx, tenantId, c.userId)
    const fmt = (v: number) => `${formatNumber(v, locale, { maximumFractionDigits: 2 })}%`
    if (await enqueueNotification(tx, {
      tenantId, userId: c.userId, code: 'content_issue_rescored',
      payload: { title: s?.title ?? '', scoreOld: fmt(c.scoreBefore ?? 0), scoreNew: fmt(c.scoreAfter) },
      dedupKey: `content_issue_rescored:${issueId}:${c.attemptId}`, refType: 'content_issue', refId: issueId,
    })) n++
  }
  return n
}

/** Авто-mute за три `spam` подряд (§7.11): человеку и его руководителю, только колокольчик. */
export async function notifyMuted(tx: TenantTx, tenantId: string, userId: string, until: Date): Promise<number> {
  // Руководитель — только через `resolveManager()` (П-16.4, решение В-7): одна точка правды
  const manager = await managerIdOf(tx, userId)
  const [person] = await tx.execute(sql`select full_name from users where id = ${userId}::uuid`) as unknown as { full_name: string }[]
  let n = 0
  const recipients = [
    ...await notDismissedOf(tx, [userId]),
    ...(manager && manager !== userId ? await activeOf(tx, [manager]) : []),
  ]
  for (const to of recipients) {
    const locale = await localeOf(tx, tenantId, to)
    if (await enqueueNotification(tx, {
      tenantId, userId: to, code: 'content_reporter_muted', channel: 'inapp',
      payload: { until: formatDate(until, locale), name: to === userId ? '' : person?.full_name ?? '' },
      dedupKey: `content_reporter_muted:${userId}:${until.toISOString().slice(0, 10)}:${to}`,
    })) n++
  }
  return n
}
