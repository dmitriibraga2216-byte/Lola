import { inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { personById } from './repo/people'
import { DEFAULT_MAX_OPEN_ITEMS } from './reviewRules'
import { resolveManager } from './orgManager'
import type { ReviewerLoad } from './reviewRules'

/**
 * Кто может проверять, кто на месте, сколько у кого работы и кому уходит эскалация —
 * факты из базы, на которых стоят распределение, делегирование и SLA (`docs/v2/37` §7.2,
 * §7.16–7.19). Решений здесь нет: их принимает `reviewRules.ts` и сервисы.
 *
 * Проверяющий — всегда сотрудник: кандидат не проверяет чужую работу ни при каких правах.
 * Поэтому каждая выборка людей здесь явно фильтрует `kind = 'employee'` (правило 17, П-16.1).
 */

const idList = (ids: string[]): SQL => sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)

/**
 * Проверяющие с правом `review.grade`, чья область покрывает точку работы (`37` §7.2 (а), (б)):
 * роль на весь тенант, на эту точку или на подразделение, внутри которого точка лежит.
 * Работа без точки (человек без размещения) никакой точки не раскрывает — подходит любой
 * проверяющий с правом оценки.
 *
 * `pointLevelOnly` — только роли, назначенные на точку или подразделение: стратегия
 * `location_mentor` («наставники точки», `37` §7.16) не должна выбирать администратора сети
 * только потому, что у него ноль открытых работ.
 */
export async function gradeReviewers(tx: TenantTx, opts: { locationId: string | null, onlyIds?: string[], pointLevelOnly?: boolean }): Promise<string[]> {
  if (opts.onlyIds && !opts.onlyIds.length) return []
  const loc = opts.locationId
  const area = loc
    ? sql`and (${opts.pointLevelOnly ? sql`false` : sql`ur.scope_type = 'tenant'`}
            or (ur.scope_type = 'location' and ur.scope_id = ${loc}::uuid)
            or (ur.scope_type = 'org_unit' and exists (
                  select 1 from locations l
                    join org_units ou on ou.id = l.org_unit_id
                    join org_units g on g.id = ur.scope_id
                   where l.id = ${loc}::uuid and ou.path <@ g.path)))`
    : opts.pointLevelOnly ? sql`and ur.scope_type <> 'tenant'` : sql``
  const rows = await tx.execute(sql`
    select distinct ur.user_id::text as id
      from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where 'review.grade' = any(r.scopes)
       and (ur.valid_until is null or ur.valid_until > now())
       and u.kind = 'employee' and u.status = 'active' and not u.is_blocked
       ${opts.onlyIds ? sql`and ur.user_id in (${idList(opts.onlyIds)})` : sql``}
       ${area}
     order by 1`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Кто отсутствует в день `day` (по умолчанию — сегодня по часам базы): `starts_on ≤ день` и
 * (`ends_on` пусто или `≥ день`) — `37` §7.18. Отсутствующий выпадает из распределения и
 * из списка делегатов.
 */
export async function absentUserIds(tx: TenantTx, opts: { userIds?: string[], day?: string } = {}): Promise<Set<string>> {
  if (opts.userIds && !opts.userIds.length) return new Set()
  const day = opts.day ? sql`${opts.day}::date` : sql`current_date`
  const rows = await tx.execute(sql`
    select distinct user_id::text as id from reviewer_absences
     where starts_on <= ${day} and (ends_on is null or ends_on >= ${day})
       ${opts.userIds ? sql`and user_id in (${idList(opts.userIds)})` : sql``}`) as unknown as { id: string }[]
  return new Set(rows.map(r => r.id))
}

export interface ReviewerCapacityRow extends ReviewerLoad {
  acceptsDelegation: boolean
  /** Пусто — любые виды работ. */
  taskTypes: string[]
  dailyTarget: number
}

/** Ёмкость и текущая нагрузка пачки проверяющих одним запросом. Нет строки ёмкости — умолчания. */
export async function reviewerLoads(tx: TenantTx, userIds: string[]): Promise<Map<string, ReviewerCapacityRow>> {
  const out = new Map<string, ReviewerCapacityRow>()
  if (!userIds.length) return out
  const rows = await tx.execute(sql`
    select x.id::text as id,
           coalesce(c.max_open_items, ${DEFAULT_MAX_OPEN_ITEMS})::int as max,
           coalesce(c.daily_target, 10)::int as daily,
           coalesce(c.rr_cursor, 0)::int as rr,
           coalesce(c.accepts_delegation, true) as accepts,
           coalesce(c.task_types, '{}'::text[]) as task_types,
           (select count(*)::int from review_queue_items q
             where q.assigned_reviewer_id = x.id and q.status <> 'done') as open
      from unnest(array[${idList(userIds)}]::uuid[]) as x(id)
      left join reviewer_capacity c on c.user_id = x.id`) as unknown as { id: string, max: number, daily: number, rr: number, accepts: boolean, task_types: string[], open: number }[]
  for (const r of rows) {
    out.set(r.id, { id: r.id, open: r.open, max: r.max, rrCursor: r.rr, acceptsDelegation: r.accepts, taskTypes: r.task_types ?? [], dailyTarget: r.daily })
  }
  return out
}

/** Активный сотрудник: может отвечать за работу. Уволенный, заблокированный, приглашённый — нет. */
export async function isActiveEmployee(tx: TenantTx, userId: string): Promise<boolean> {
  const [p] = await personById(tx, { kind: users.kind, status: users.status, isBlocked: users.isBlocked }, userId)
  return !!p && p.kind === 'employee' && p.status === 'active' && !p.isBlocked
}

/** ФИО пачки людей по первичному ключу — для текста уведомлений и строк очереди. */
export async function namesOf(tx: TenantTx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((v): v is string => !!v))]
  if (!list.length) return new Map()
  const rows = await tx.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, list))
  return new Map(rows.map(r => [r.id, r.fullName]))
}

/**
 * Руководители человека снизу вверх — кому уходит нарушение срока и эскалация (`37` §7.19,
 * §12 «эскалация на руководителя, который сам и есть проверяющий → уровнем выше»).
 *
 * Единственный источник истины о руководителе — `resolveManager()` (П-16.4, PR-30): дерево
 * подчинения, если тенант объявил его источником истины, иначе держатель точки, иначе роль в
 * области. Цепочка вверх есть только у дерева; у точки уровня выше нет, и следующим шагом
 * становится администратор тенанта (`tenantAdmins`) — это и есть «фолбэк на администратора»
 * из плана PR-19, который снимает PR-31 эскалацией по дереву.
 */
export async function managerChainOf(tx: TenantTx, tenantId: string, userId: string): Promise<string[]> {
  const r = await resolveManager(tx, userId, { tenantId })
  if (r.chain.length) return r.chain.filter(id => id !== userId)
  return r.managerUserId && r.managerUserId !== userId ? [r.managerUserId] : []
}

/**
 * Администраторы тенанта — последний адресат эскалации (`37` §12: «выше некуда —
 * администратору тенанта»). Признак — не код роли, а право: роль на весь тенант со скоупом
 * `review.delegate.any`, то есть тот, кто вправе распоряжаться любой проверкой сети. Порядок —
 * кто получил роль раньше: адресат стабилен от прогона к прогону.
 */
export async function tenantAdmins(tx: TenantTx): Promise<string[]> {
  const rows = await tx.execute(sql`
    select ur.user_id::text as id, min(ur.created_at) as since
      from user_roles ur
      join roles r on r.id = ur.role_id
      join users u on u.id = ur.user_id
     where ur.scope_type = 'tenant' and 'review.delegate.any' = any(r.scopes)
       and (ur.valid_until is null or ur.valid_until > now())
       and u.kind = 'employee' and u.status = 'active' and not u.is_blocked
     group by ur.user_id
     order by since, id`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Кому уходят нарушение срока и эскалация (`37` §7.19): руководитель области проверяемого, а
 * если он сам и есть проверяющий или сам сдал эту работу — уровнем выше; выше некуда —
 * администратор тенанта. `source` пишется в `review_sla_events.details`: по нему видно, что
 * сработал фолбэк, а не дерево.
 */
export async function escalationTarget(tx: TenantTx, item: { tenantId: string, userId: string, assignedReviewerId: string | null }): Promise<{ id: string, source: 'manager' | 'admin' } | null> {
  const skip = new Set([item.userId, item.assignedReviewerId].filter((v): v is string => !!v))
  for (const id of await managerChainOf(tx, item.tenantId, item.userId)) {
    if (!skip.has(id) && await isActiveEmployee(tx, id)) return { id, source: 'manager' }
  }
  for (const id of await tenantAdmins(tx)) {
    if (!skip.has(id)) return { id, source: 'admin' }
  }
  return null
}
