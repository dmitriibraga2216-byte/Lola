import { asc, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { contentIssueEvents, contentIssueRoutingRules, contentIssues } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { recordAudit } from './audit'
import { ACTIVE_EMPLOYEES_ONLY, EMPLOYEES_ONLY } from './repo/people'
import { OPEN_STATUSES, matchingRules, routingSetValid } from '../../shared/domain/contentIssues'
import type { ContentIssueTargetType } from '../../shared/enums'
import type { RoutingRuleInput, RoutingRulePatch, RoutingRuleRow } from '../../shared/schemas/contentIssues'

/**
 * Маршрутизация жалобы (docs/v2/36-content-feedback.md §7.5): кому уходит карточка.
 *
 * Порядок — ровно по документу, и каждый шаг пропускает неактивных людей:
 *   (а) первое активное правило по `sort`, совпавшее по типу элемента, проблемы и категории;
 *   (б) первый действующий из авторов материала или теста;
 *   (в) владелец категории курса — если все авторы неактивны;
 *   (г) запасное правило тенанта;
 *   (д) любой носитель `content_issue.triage` с наименьшим числом открытых карточек.
 *
 * «Неактивен» здесь не определяется заново: это та отметка, которую ставит офбординг PR-07
 * (`status = 'archived'`) и блокировка входа, и то же условие, по которому считается ось
 * лимита `users_active` — `ACTIVE_EMPLOYEES_ONLY()` из репозитория людей. Поэтому уволенный
 * автор не блокирует маршрутизацию (критерий приёмки 8): шаг (б) его просто не видит.
 */

export interface Ctx { tenantId: string, actorId: string }

export type RouteStep = 'rule' | 'author' | 'category_owner' | 'fallback' | 'least_loaded' | 'none'
export interface RouteResult { assigneeId: string | null, step: RouteStep, ruleId: string | null }

const OPEN = sql.raw(OPEN_STATUSES.map(s => `'${s}'`).join(', '))

/** `array[$1::uuid, …]::uuid[]` — postgres-js не выводит тип uuid[] из массива параметров сам. */
export function uuidArray(ids: readonly string[]): SQL {
  return ids.length ? sql`array[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`
}

/**
 * Авторы элемента карточки с алиасом `alias` (§7.5 б) — упорядоченный `uuid[]`.
 * Материал и тест несут `author_ids`; вопрос — авторов тестов, в которых он стоит; урок —
 * авторов своего материала или теста, а если их нет — создателя курса; опрос — создателя,
 * статья базы знаний — ответственного за актуальность, медиа — владельца файла.
 */
export function authorIdsSql(alias = 'i'): SQL {
  const i = sql.raw(alias)
  return sql`coalesce(case ${i}.target_type
      when 'resource' then (select r.author_ids from resources r where r.id = ${i}.target_id)
      when 'block' then (select r.author_ids from resources r where r.id = ${i}.target_id)
      when 'quiz' then (select q.author_ids from quizzes q where q.id = ${i}.target_id)
      when 'workshop' then (select w.author_ids from workshops w where w.id = ${i}.target_id)
      when 'question' then (select array_agg(a.id order by q.created_at, a.ord) from quiz_questions qq
                              join quizzes q on q.id = qq.quiz_id
                              cross join lateral unnest(q.author_ids) with ordinality a(id, ord)
                             where qq.question_id = ${i}.target_id)
      when 'lesson' then (select coalesce(nullif(case l.item_type
                                 when 'resource' then (select r.author_ids from resources r where r.id = l.item_id)
                                 when 'quiz' then (select q.author_ids from quizzes q where q.id = l.item_id)
                                 when 'workshop' then (select w.author_ids from workshops w where w.id = l.item_id)
                               end, '{}'::uuid[]),
                               (select array_remove(array[c.created_by], null) from modules m
                                  join course_versions cv on cv.id = m.course_version_id
                                  join courses c on c.id = cv.course_id
                                 where m.id = l.module_id))
                            from lessons l where l.id = ${i}.target_id)
      when 'survey' then (select array_remove(array[s.created_by], null) from surveys s where s.id = ${i}.target_id)
      when 'knowledge_article' then (select array_remove(array[ka.owner_id], null) from knowledge_articles ka where ka.id = ${i}.target_id)
      when 'media' then (select array_remove(array[ma.owner_user_id], null) from media_assets ma where ma.id = ${i}.target_id)
    end, '{}'::uuid[])`
}

/**
 * Курсы, в которых встречается элемент (колонка «Трек» очереди, §5.3): через уроки любых
 * версий курса. Заявитель пришёл из одного курса, но тот же материал бывает в трёх — и
 * методисту важно видеть все три раньше, чем он откроет карточку (§14).
 */
export async function derivedCourseIds(tx: TenantTx, targetType: ContentIssueTargetType, targetId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct cv.course_id as id
      from lessons l
      join modules m on m.id = l.module_id
      join course_versions cv on cv.id = m.course_version_id
      join courses c on c.id = cv.course_id and c.deleted_at is null
     where (${targetType} = 'lesson' and l.id = ${targetId}::uuid)
        or (${targetType} in ('resource', 'block') and l.item_type = 'resource' and l.item_id = ${targetId}::uuid)
        or (${targetType} = 'quiz' and l.item_type = 'quiz' and l.item_id = ${targetId}::uuid)
        or (${targetType} = 'workshop' and l.item_type = 'workshop' and l.item_id = ${targetId}::uuid)
        or (${targetType} = 'question' and l.item_type = 'quiz'
            and l.item_id in (select qq.quiz_id from quiz_questions qq where qq.question_id = ${targetId}::uuid))`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Категории элемента по порядку (§7.5 а, в): сначала категории курсов (в порядке
 * `course_ids`), затем собственная категория статьи базы знаний или банка вопроса.
 */
async function categoryIdsOf(tx: TenantTx, issue: { targetType: string, targetId: string, courseIds: string[] }): Promise<string[]> {
  const rows = await tx.execute(sql`
    select category_id as id from (
      select c.category_id, x.ord from unnest(${uuidArray(issue.courseIds)}) with ordinality x(id, ord)
        join courses c on c.id = x.id
       where c.category_id is not null
      union all
      select ka.category_id, 1000000 from knowledge_articles ka
       where ${issue.targetType} = 'knowledge_article' and ka.id = ${issue.targetId}::uuid and ka.category_id is not null
      union all
      select qb.category_id, 1000001 from questions q join question_banks qb on qb.id = q.bank_id
       where ${issue.targetType} = 'question' and q.id = ${issue.targetId}::uuid and qb.category_id is not null
    ) s order by ord`) as unknown as { id: string }[]
  return [...new Set(rows.map(r => r.id))]
}

function excludeSql(exclude: ReadonlySet<string>, alias = 'u'): SQL {
  return exclude.size ? sql`and ${sql.raw(alias)}.id <> all(${uuidArray([...exclude])})` : sql``
}

/** Первый действующий сотрудник из списка — в порядке списка (§7.5 б, в). */
async function firstActive(tx: TenantTx, ids: readonly string[], exclude: ReadonlySet<string>): Promise<string | null> {
  if (!ids.length) return null
  const [row] = await tx.execute(sql`
    select u.id from unnest(${uuidArray(ids)}) with ordinality x(id, ord)
      join users u on u.id = x.id
     where true ${ACTIVE_EMPLOYEES_ONLY('u')} ${excludeSql(exclude)}
     order by x.ord limit 1`) as unknown as { id: string }[]
  return row?.id ?? null
}

/**
 * Наименее загруженный действующий носитель роли или скоупа: открытых карточек меньше всех,
 * при равенстве — стабильно по id. Истёкшая роль прав не даёт (docs/16 §6.2).
 */
async function leastLoaded(tx: TenantTx, by: { roleId: string } | { scope: string }, exclude: ReadonlySet<string>): Promise<string | null> {
  const holds = 'roleId' in by
    ? sql`exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role_id = ${by.roleId}::uuid
                    and (ur.valid_until is null or ur.valid_until > now()))`
    : sql`exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                   where ur.user_id = u.id and r.scopes @> array[${by.scope}]::text[]
                     and (ur.valid_until is null or ur.valid_until > now()))`
  const [row] = await tx.execute(sql`
    select u.id from users u
     where ${holds} ${ACTIVE_EMPLOYEES_ONLY('u')} ${excludeSql(exclude)}
     order by (select count(*) from content_issues ci where ci.assignee_id = u.id and ci.status in (${OPEN})), u.id
     limit 1`) as unknown as { id: string }[]
  return row?.id ?? null
}

async function ruleAssignee(tx: TenantTx, rule: { assigneeUserId: string | null, assigneeRoleId: string | null }, exclude: ReadonlySet<string>): Promise<string | null> {
  if (rule.assigneeUserId) return firstActive(tx, [rule.assigneeUserId], exclude)
  if (rule.assigneeRoleId) return leastLoaded(tx, { roleId: rule.assigneeRoleId }, exclude)
  return null
}

/**
 * Кому отдать карточку (§7.5). `exclude` — люди, которым отдавать нельзя: переназначение
 * неактивного ответственного исключает его самого, даже если отметка ещё не встала.
 */
export async function routeIssueTx(tx: TenantTx, issueId: string, opts: { exclude?: string[] } = {}): Promise<RouteResult> {
  const [row] = await tx.execute(sql`
    select i.target_type, i.target_id, i.issue_type, i.course_ids, ${authorIdsSql('i')} as author_ids
      from content_issues i where i.id = ${issueId}::uuid`) as unknown as {
    target_type: string, target_id: string, issue_type: string, course_ids: string[], author_ids: string[]
  }[]
  if (!row) return { assigneeId: null, step: 'none', ruleId: null }
  const exclude = new Set(opts.exclude ?? [])
  const categoryIds = await categoryIdsOf(tx, { targetType: row.target_type, targetId: row.target_id, courseIds: row.course_ids ?? [] })

  const rules = await tx.select().from(contentIssueRoutingRules).where(eq(contentIssueRoutingRules.isActive, true))

  // (а) правила по порядку; неактивный адресат правила не останавливает поиск
  for (const rule of matchingRules(rules, { targetType: row.target_type, issueType: row.issue_type, categoryIds })) {
    const who = await ruleAssignee(tx, rule, exclude)
    if (who) return { assigneeId: who, step: 'rule', ruleId: rule.id }
  }
  // (б) первый действующий автор
  const author = await firstActive(tx, row.author_ids ?? [], exclude)
  if (author) return { assigneeId: author, step: 'author', ruleId: null }
  // (в) владелец категории курса — все авторы неактивны (уволены, заблокированы) или их нет
  if (categoryIds.length) {
    const owners = await tx.execute(sql`
      select x.id as category_id, cc.owner_id from unnest(${uuidArray(categoryIds)}) with ordinality x(id, ord)
        join course_categories cc on cc.id = x.id
       where cc.owner_id is not null order by x.ord`) as unknown as { owner_id: string }[]
    const owner = await firstActive(tx, owners.map(o => o.owner_id), exclude)
    if (owner) return { assigneeId: owner, step: 'category_owner', ruleId: null }
  }
  // (г) запасное правило тенанта
  const fallback = rules.find(r => r.fallback)
  if (fallback) {
    const who = await ruleAssignee(tx, fallback, exclude)
    if (who) return { assigneeId: who, step: 'fallback', ruleId: fallback.id }
  }
  // (д) любой, кто вправе разбирать, — с наименьшей очередью
  const lazy = await leastLoaded(tx, { scope: 'content_issue.triage' }, exclude)
  if (lazy) return { assigneeId: lazy, step: 'least_loaded', ruleId: null }
  return { assigneeId: null, step: 'none', ruleId: null }
}

/**
 * Проставить ответственного и записать событие `assigned` (§3). `actorId = null` — система
 * (маршрутизация при подаче, переназначение фоновой задачей); иначе — кто переназначил.
 */
export async function assignTx(
  tx: TenantTx,
  tenantId: string,
  issueId: string,
  assigneeId: string,
  meta: { actorId: string | null, from: string | null, step: RouteStep | 'manual', ruleId?: string | null },
): Promise<void> {
  const now = new Date()
  await tx.update(contentIssues)
    .set({ assigneeId, assignedAt: now, updatedAt: now })
    .where(eq(contentIssues.id, issueId))
  await tx.insert(contentIssueEvents).values({
    tenantId,
    issueId,
    actorId: meta.actorId,
    kind: 'assigned',
    payload: { from: meta.from, to: assigneeId, step: meta.step, rule_id: meta.ruleId ?? null },
    requestContext: currentRequestContext(),
  })
}

/**
 * `content_issue.reassign_scan` (§11, ежедневно): открытые карточки неактивных ответственных
 * уходят следующему по той же маршрутизации. Увольнение ответственного не оставляет жалобы
 * лежать на человеке, который их уже не увидит (§7.5 последняя фраза).
 */
export async function reassignScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const stale = await tx.execute(sql`
      select i.id, i.assignee_id from content_issues i
       where i.status in (${OPEN}) and i.assignee_id is not null
         and not exists (select 1 from users u where u.id = i.assignee_id ${ACTIVE_EMPLOYEES_ONLY('u')})`) as unknown as { id: string, assignee_id: string }[]
    let moved = 0
    for (const s of stale) {
      const route = await routeIssueTx(tx, s.id, { exclude: [s.assignee_id] })
      if (!route.assigneeId) continue
      await assignTx(tx, tenantId, s.id, route.assigneeId, { actorId: null, from: s.assignee_id, step: route.step, ruleId: route.ruleId })
      const { notifyAssignee } = await import('./contentIssueNotify')
      await notifyAssignee(tx, tenantId, s.id, 'content_issue_created')
      moved++
    }
    return moved
  })
}

// ── Правила адресации: CRUD `/settings/content-issue-routing-rules` (§6.3, §10) ─────────────

export type RuleError = 'not_found' | 'fallback_rule_required' | 'reference_not_found'

async function listRulesTx(tx: TenantTx): Promise<RoutingRuleRow[]> {
  const rows = await tx.execute(sql`
    select r.id, r.sort, r.target_type, r.issue_type, r.category_id, r.assignee_user_id, r.assignee_role_id,
           r.fallback, r.is_active, u.full_name as assignee_name, ro.name as role_name, cc.name as category_name,
           exists (select 1 from users a where a.id = r.assignee_user_id ${ACTIVE_EMPLOYEES_ONLY('a')}) as assignee_active
      from content_issue_routing_rules r
      left join users u on u.id = r.assignee_user_id
      left join roles ro on ro.id = r.assignee_role_id
      left join course_categories cc on cc.id = r.category_id
     order by r.fallback desc, r.sort, r.created_at`) as unknown as {
    id: string, sort: number, target_type: string | null, issue_type: string | null, category_id: string | null,
    assignee_user_id: string | null, assignee_role_id: string | null, fallback: boolean, is_active: boolean,
    assignee_name: string | null, role_name: string | null, category_name: string | null, assignee_active: boolean
  }[]
  return rows.map(r => ({
    id: r.id,
    sort: Number(r.sort),
    targetType: r.target_type as RoutingRuleRow['targetType'],
    issueType: r.issue_type as RoutingRuleRow['issueType'],
    categoryId: r.category_id,
    categoryName: r.category_name,
    assigneeUserId: r.assignee_user_id,
    assigneeName: r.assignee_name,
    // Уволенный адресат правила не ломает маршрутизацию, но экран обязан это показать
    assigneeActive: r.assignee_user_id ? r.assignee_active : null,
    assigneeRoleId: r.assignee_role_id,
    roleName: r.role_name,
    fallback: r.fallback,
    isActive: r.is_active,
  }))
}

export async function listRoutingRules(ctx: Ctx): Promise<RoutingRuleRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => listRulesTx(tx))
}

/** Ссылки правила принадлежат тенанту (RLS сужает выборку): чужой id — «не найдено», а не 403. */
async function referencesExist(tx: TenantTx, r: { categoryId?: string | null, assigneeUserId?: string | null, assigneeRoleId?: string | null }): Promise<boolean> {
  if (r.categoryId) {
    const [c] = await tx.execute(sql`select 1 from course_categories where id = ${r.categoryId}::uuid`) as unknown as unknown[]
    if (!c) return false
  }
  if (r.assigneeUserId) {
    const [u] = await tx.execute(sql`select 1 from users u where u.id = ${r.assigneeUserId}::uuid ${EMPLOYEES_ONLY('u')}`) as unknown as unknown[]
    if (!u) return false
  }
  if (r.assigneeRoleId) {
    const [ro] = await tx.execute(sql`select 1 from roles where id = ${r.assigneeRoleId}::uuid`) as unknown as unknown[]
    if (!ro) return false
  }
  return true
}

/** У запасного правила фильтров нет по смыслу (§7.5 г): оно ловит всё, что не поймали шаги а–в. */
function normalize<T extends { fallback?: boolean, targetType?: unknown, issueType?: unknown, categoryId?: unknown }>(r: T): T {
  return r.fallback ? { ...r, targetType: null, issueType: null, categoryId: null } : r
}

export async function createRoutingRule(ctx: Ctx, input: RoutingRuleInput): Promise<{ ok: true, rule: RoutingRuleRow } | { ok: false, code: RuleError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const data = normalize(input)
    if (!await referencesExist(tx, data)) return { ok: false as const, code: 'reference_not_found' as const }
    const existing = await tx.select({ fallback: contentIssueRoutingRules.fallback, isActive: contentIssueRoutingRules.isActive }).from(contentIssueRoutingRules)
    if (!routingSetValid([...existing, { fallback: data.fallback, isActive: data.isActive }])) return { ok: false as const, code: 'fallback_rule_required' as const }
    const [row] = await tx.insert(contentIssueRoutingRules).values({ tenantId: ctx.tenantId, ...data }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'content_issue.routing_rule.create', entity: 'content_issue_routing_rule', entityId: row!.id, after: data })
    const rule = (await listRulesTx(tx)).find(r => r.id === row!.id)!
    return { ok: true as const, rule }
  })
}

export async function updateRoutingRule(ctx: Ctx, id: string, patch: RoutingRulePatch): Promise<{ ok: true, rule: RoutingRuleRow } | { ok: false, code: RuleError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const all = await tx.select().from(contentIssueRoutingRules).orderBy(asc(contentIssueRoutingRules.sort))
    const before = all.find(r => r.id === id)
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const merged = normalize({ ...before, ...patch })
    if (!merged.assigneeUserId && !merged.assigneeRoleId) return { ok: false as const, code: 'reference_not_found' as const }
    if (!await referencesExist(tx, patch)) return { ok: false as const, code: 'reference_not_found' as const }
    const next = all.map(r => r.id === id ? merged : r)
    if (!routingSetValid(next)) return { ok: false as const, code: 'fallback_rule_required' as const }
    await tx.update(contentIssueRoutingRules).set({
      sort: merged.sort,
      targetType: merged.targetType,
      issueType: merged.issueType,
      categoryId: merged.categoryId,
      assigneeUserId: merged.assigneeUserId,
      assigneeRoleId: merged.assigneeRoleId,
      fallback: merged.fallback,
      isActive: merged.isActive,
      updatedAt: new Date(),
    }).where(eq(contentIssueRoutingRules.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'content_issue.routing_rule.update', entity: 'content_issue_routing_rule', entityId: id, before, after: patch })
    const rule = (await listRulesTx(tx)).find(r => r.id === id)!
    return { ok: true as const, rule }
  })
}

export async function deleteRoutingRule(ctx: Ctx, id: string): Promise<{ ok: true } | { ok: false, code: RuleError }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const all = await tx.select().from(contentIssueRoutingRules)
    const before = all.find(r => r.id === id)
    if (!before) return { ok: false as const, code: 'not_found' as const }
    // Последним удаляется запасное правило: без него непустой набор правил неполон (§6.3)
    if (!routingSetValid(all.filter(r => r.id !== id))) return { ok: false as const, code: 'fallback_rule_required' as const }
    await tx.delete(contentIssueRoutingRules).where(eq(contentIssueRoutingRules.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'content_issue.routing_rule.delete', entity: 'content_issue_routing_rule', entityId: id, before })
    return { ok: true as const }
  })
}
