import { gt, ne, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import {
  ENGAGEMENT_BATCH_SIZE, ENGAGEMENT_FORMULA_VERSION, ENGAGEMENT_HELP_KINDS, ENGAGEMENT_RECALC_COOLDOWN_MINUTES,
  ENGAGEMENT_WINDOW_DAYS, computeEngagementIndex, isEngagementStale,
} from '../../shared/domain/engagementIndex'
import type { EngagementState, EngagementView, IndexBreakdown, IndexEnrollment, IndexInput, IndexResult } from '../../shared/domain/engagementIndex'
import type { StageCapabilityMap } from '../../shared/enums'
import type { Access } from './access'
import { areaCovers, areaOf } from './access'
import { recordAudit } from './audit'
import { stageCan } from './lifecycle'
import { cardSubject } from './personCard'
import type { CardSubject } from './personCard'
import { employees } from './repo/people'
import { frameJoins, frameWhere } from './reportFrame'

/**
 * Індекс навчальної залученості (docs/v2/38-people-extensions.md §3.1, §3.7, §5.2–§5.3, §7.1–§7.3,
 * §10, §11; PR-35). Единственный писатель `person_rating_snapshots`, `users.rating_pct` и
 * `users.rating_updated_at`.
 *
 * **Не «Поточний рейтинг».** Баллы рейтинга (`points_ledger`, docs/33 D-069, `reportsExtra.ts`
 * `studyHistory().currentRating`) — валюта геймификации; здесь — справочный индекс 0…130 %,
 * который не начисляется, а целиком пересчитывается из первичных данных. Баллы и бейджи в формулу
 * не входят (`38` §7.1 [решение]); общее у них одно — событие `enrollment_completed`.
 *
 * **Пересчёт целиком, раз в сутки** (§7.2): задача `rating.recalc` (04:00 по Киеву, партиями по
 * 500 человек, круг `runPerTenant`, каждая партия — своя транзакция `withTenant()`) читает записи
 * на курс окна и суточный агрегат ленты, считает формулу (`computeEngagementIndex()`), пишет
 * снимок с числами формулы и копию итога в `users.rating_pct`. Инкрементальных доначислений нет —
 * это и есть объяснимость: любое число воспроизводится из `enrollments` и `user_activity_daily`.
 *
 * Кто в расчёте: только сотрудники (инвариант 17, `employees()`); кандидату индекс не считается
 * вовсе. Уволенному (`status = 'archived'`) фиксируется последнее значение — его не пересчитывают.
 * Скрытый (`is_hidden`) считается, но не попадает в распределения и сравнения (§7.2).
 *
 * Какие записи на курс в окне (§7.1): срок (`due_at`) или завершение (`completed_at`) в последних
 * 365 днях, плюс все активные на дату расчёта. Не входят: снятые (`cancelled_at`), заявки каталога
 * (`not_assigned`), ещё не открытые (`starts_at` в будущем — пройти их нельзя, штрафовать нечем),
 * и записи на курс этапа без возможности `counts_in_rating` («назначения этапа не влияют на
 * рейтинг», docs/v2/33 §3.3, критерий `33` §13 к. 4) — решение по этапу принимает `stageCan()`.
 */

interface Ctx { tenantId: string, actorId: string | null }

/** Окно расчёта: дата расчёта в календаре тенанта и 365 дней назад включительно. */
interface CalcWindow {
  calcDate: string
  from: string
  /** Начало окна как момент — полночь `from` в поясе тенанта. */
  fromTs: string
}

async function calcWindow(tx: TenantTx, tenantId: string): Promise<CalcWindow> {
  const [w] = await tx.execute(sql`
    select d::text as calc_date, (d - ${ENGAGEMENT_WINDOW_DAYS - 1}::int)::text as window_from,
           to_char(((d - ${ENGAGEMENT_WINDOW_DAYS - 1}::int)::timestamp at time zone tz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as from_ts
    from (select (now() at time zone coalesce(t.timezone, 'Europe/Kyiv'))::date as d, coalesce(t.timezone, 'Europe/Kyiv') as tz
          from tenants t where t.id = ${tenantId}::uuid) x`) as unknown as { calc_date: string, window_from: string, from_ts: string }[]
  if (!w) throw new Error(`engagement: тенант ${tenantId} не найден`)
  return { calcDate: w.calc_date, from: w.window_from, fromTs: w.from_ts }
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString())

/** Входы формулы для партии людей — три запроса на партию, а не на человека. */
async function collectInputs(tx: TenantTx, ids: readonly string[], win: CalcWindow): Promise<Map<string, IndexInput>> {
  const out = new Map<string, IndexInput>(ids.map(id => [id, { enrollments: [], longestStreak: 0, help: { reviews: 0, issues: 0 } }]))
  if (!ids.length) return out

  const rows = await tx.execute(sql`
    select e.id::text as enrollment_id, e.user_id::text as user_id, e.subject_id::text as subject_id,
           c.title, coalesce(a.is_mandatory, false) as mandatory, e.status, e.progress_pct::float8 as progress_pct,
           greatest(e.created_at, coalesce(e.starts_at, e.created_at)) as assigned_at, e.due_at, e.completed_at,
           ls.capabilities
      from enrollments e
      join courses c on c.id = e.subject_id
      left join lifecycle_stages ls on ls.id = c.lifecycle_stage_id
      left join assignments a on a.id = e.assignment_id
     where e.user_id in ${ids}
       and e.cancelled_at is null
       and e.status in ('not_started', 'in_progress', 'done', 'failed')
       and (e.starts_at is null or e.starts_at <= now())
       and (   (e.due_at >= ${win.fromTs}::timestamptz and e.due_at <= now())
            or (e.completed_at >= ${win.fromTs}::timestamptz and e.completed_at <= now())
            or e.status in ('not_started', 'in_progress'))
     order by e.created_at, e.id`) as unknown as {
    enrollment_id: string, user_id: string, subject_id: string, title: string, mandatory: boolean, status: string,
    progress_pct: number, assigned_at: Date | string, due_at: Date | string | null, completed_at: Date | string | null,
    capabilities: StageCapabilityMap | null
  }[]
  for (const r of rows) {
    // Этап курса решает, входит ли запись в индекс: `stageCan()` — единственная точка (`33` §7.1)
    if (!stageCan(r.capabilities ? { capabilities: r.capabilities } : null, 'counts_in_rating')) continue
    const e: IndexEnrollment = {
      enrollmentId: r.enrollment_id,
      subjectId: r.subject_id,
      title: r.title,
      mandatory: r.mandatory,
      status: r.status,
      progressPct: Number(r.progress_pct) || 0,
      assignedAt: iso(r.assigned_at)!,
      dueAt: iso(r.due_at),
      completedAt: iso(r.completed_at),
    }
    ;(out.get(r.user_id)!.enrollments as IndexEnrollment[]).push(e)
  }

  await activityInputs(tx, ids, win, out)
  return out
}

/** `S` и `H` из суточного агрегата ленты за окно — общие для ежедневного расчёта и ретро-расчёта. */
async function activityInputs(tx: TenantTx, ids: readonly string[], win: CalcWindow, out: Map<string, IndexInput>): Promise<void> {
  // S — самая длинная серия локальных дней с `level > 0` («острова» подряд идущих дат)
  const streaks = await tx.execute(sql`
    select user_id::text as user_id, max(len)::int as longest from (
      select user_id, count(*) as len from (
        select user_id, local_date - (row_number() over (partition by user_id order by local_date))::int as grp
          from user_activity_daily
         where user_id in ${ids} and level > 0 and local_date between ${win.from}::date and ${win.calcDate}::date
      ) d group by user_id, grp
    ) s group by user_id`) as unknown as { user_id: string, longest: number }[]
  for (const s of streaks) out.get(s.user_id)!.longestStreak = Number(s.longest) || 0

  // H — действия помощи из разбивки дня по видам: агрегат хранится бессрочно (§7.2, §7.11)
  const [reviewKind, issueKind] = ENGAGEMENT_HELP_KINDS
  const help = await tx.execute(sql`
    select user_id::text as user_id,
           coalesce(sum((kinds ->> ${reviewKind})::int), 0)::int as reviews,
           coalesce(sum((kinds ->> ${issueKind})::int), 0)::int as issues
      from user_activity_daily
     where user_id in ${ids} and local_date between ${win.from}::date and ${win.calcDate}::date
     group by user_id`) as unknown as { user_id: string, reviews: number, issues: number }[]
  for (const h of help) out.get(h.user_id)!.help = { reviews: Number(h.reviews) || 0, issues: Number(h.issues) || 0 }

}

/**
 * Записать итог человека: снимок дня (повторный расчёт в тот же день — перезапись), снятие
 * `is_current` с прежнего, копия итога в `users`. `null` — «не рассчитан»: текущего снимка нет,
 * `rating_pct = null` (в списке «—», не «0 %», §7.2).
 */
async function writeResult(tx: TenantTx, tenantId: string, userId: string, win: CalcWindow, r: IndexResult | null): Promise<void> {
  await tx.execute(sql`update person_rating_snapshots set is_current = false
    where user_id = ${userId}::uuid and is_current and (${r === null}::boolean or calc_date <> ${win.calcDate}::date)`)
  if (r) {
    await tx.execute(sql`
      insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
      values (${tenantId}::uuid, ${userId}::uuid, ${win.calcDate}::date, ${r.base}, ${r.early}, ${r.streak}, ${r.help}, ${r.total},
              ${JSON.stringify(r.breakdown)}::jsonb, ${win.from}::date, ${win.calcDate}::date, true)
      on conflict (tenant_id, user_id, calc_date) do update set
        base_pct = excluded.base_pct, bonus_early = excluded.bonus_early, bonus_streak = excluded.bonus_streak,
        bonus_help = excluded.bonus_help, total_pct = excluded.total_pct, breakdown = excluded.breakdown,
        window_from = excluded.window_from, window_to = excluded.window_to, is_current = true, created_at = now()`)
  }
  await tx.execute(sql`update users set rating_pct = ${r ? r.total : null}, rating_updated_at = now() where id = ${userId}::uuid`)
}

export interface RecalcStats { people: number, rated: number, empty: number }

/**
 * `rating.recalc` (§11) — полный пересчёт тенанта партиями по 500: сотрудники, кроме уволенных,
 * по возрастанию id (ключевой курсор, партия — своя транзакция: сбой одной не откатывает прошлые).
 */
export async function recalcTenantEngagement(tenantId: string): Promise<RecalcStats> {
  const stats: RecalcStats = { people: 0, rated: 0, empty: 0 }
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const n = await withTenant(tenantId, null, async (tx) => {
      const batch = await employees(tx, { id: users.id }, ne(users.status, 'archived'), gt(users.id, after))
        .orderBy(users.id).limit(ENGAGEMENT_BATCH_SIZE)
      if (!batch.length) return 0
      const win = await calcWindow(tx, tenantId)
      const ids = batch.map(b => b.id)
      const inputs = await collectInputs(tx, ids, win)
      for (const id of ids) {
        const r = computeEngagementIndex(inputs.get(id)!)
        await writeResult(tx, tenantId, id, win, r)
        stats.people++
        if (r) stats.rated++
        else stats.empty++
      }
      after = ids[ids.length - 1]!
      return batch.length
    })
    if (n < ENGAGEMENT_BATCH_SIZE) break
  }
  return stats
}

// ── Чтение: `GET /people/:id/rating` (§5.3, §10) ─────────────────────────────────────────

/**
 * Кто видит чужой индекс (§2): носитель `person.rating.view_others` в области, покрывающей
 * **текущую** точку человека (руководитель — свои точки, HR и администратор — тенант). Свой —
 * каждый сотрудник, без скоупа. Токен интеграции прав по данным не получает — только скоуп.
 */
export type EngagementScope = 'self' | 'full' | 'none'

async function scopeOf(access: Access, subject: CardSubject): Promise<EngagementScope> {
  if (access.viaToken !== true && access.userId === subject.id) return 'self'
  return areaCovers(await areaOf(access, 'person.rating.view_others'), subject.locationId) ? 'full' : 'none'
}

export type EngagementResult = { ok: true, data: EngagementView } | { ok: false, code: 'not_found' | 'forbidden' | 'person_archived' | 'recalc_too_often' }

async function buildView(tx: TenantTx, subject: CardSubject, self: boolean): Promise<EngagementView> {
  const [u] = await tx.execute(sql`select rating_pct::float8 as rating_pct, rating_updated_at from users where id = ${subject.id}::uuid`) as unknown as { rating_pct: number | null, rating_updated_at: Date | string | null }[]
  const [snap] = await tx.execute(sql`
    select calc_date::text as calc_date, base_pct::float8 as base, bonus_early::float8 as early, bonus_streak::float8 as streak,
           bonus_help::float8 as help, total_pct::float8 as total, breakdown, window_from::text as window_from, window_to::text as window_to
      from person_rating_snapshots where user_id = ${subject.id}::uuid and is_current`) as unknown as {
    calc_date: string, base: number, early: number, streak: number, help: number, total: number, breakdown: IndexBreakdown, window_from: string, window_to: string
  }[]
  const history = await tx.execute(sql`
    select month, total from (
      select distinct on (to_char(calc_date, 'YYYY-MM')) to_char(calc_date, 'YYYY-MM') as month, total_pct::float8 as total
        from person_rating_snapshots
       where user_id = ${subject.id}::uuid and calc_date > current_date - ${ENGAGEMENT_WINDOW_DAYS}::int
       order by to_char(calc_date, 'YYYY-MM'), calc_date desc
    ) m order by month`) as unknown as { month: string, total: number }[]
  // «Формулу змінено {дата}» (§7.2): есть снимки другой версии — с какой даты считается текущей
  const [changed] = await tx.execute(sql`
    select min(calc_date)::text as since from person_rating_snapshots p
     where p.user_id = ${subject.id}::uuid and coalesce((p.breakdown ->> 'formula_version')::int, 0) = ${ENGAGEMENT_FORMULA_VERSION}::int
       and exists (select 1 from person_rating_snapshots o where o.user_id = p.user_id
                    and coalesce((o.breakdown ->> 'formula_version')::int, 0) <> ${ENGAGEMENT_FORMULA_VERSION}::int)`) as unknown as { since: string | null }[]

  const updatedAt = u?.rating_updated_at ? new Date(u.rating_updated_at).toISOString() : null
  const state: EngagementState = snap ? 'ok' : updatedAt ? 'no_assignments' : 'pending'
  return {
    person: { id: subject.id, fullName: subject.fullName },
    self,
    state,
    total: snap ? Number(snap.total) : null,
    base: snap ? Number(snap.base) : null,
    bonuses: snap ? { early: Number(snap.early), streak: Number(snap.streak), help: Number(snap.help) } : null,
    breakdown: snap?.breakdown ?? null,
    window: snap ? { from: snap.window_from, to: snap.window_to } : null,
    calcDate: snap?.calc_date ?? null,
    updatedAt,
    stale: isEngagementStale(updatedAt),
    formula: { version: ENGAGEMENT_FORMULA_VERSION, changedAt: changed?.since ?? null },
    history: history.map(h => ({ month: h.month, total: Number(h.total) })),
  }
}

/** `GET /people/:id/rating`: цифра, слагаемые, числа формулы, окно, динамика. */
export async function personEngagement(access: Access, personId: string): Promise<EngagementResult> {
  return withTenant(access.tenantId, access.userId, async (tx) => {
    const subject = await cardSubject(tx, personId)
    if (!subject) return { ok: false as const, code: 'not_found' as const }
    const scope = await scopeOf(access, subject)
    if (scope === 'none') return { ok: false as const, code: 'forbidden' as const }
    return { ok: true as const, data: await buildView(tx, subject, scope === 'self') }
  })
}

/**
 * `POST /people/:id/rating/recalc` (§10): пересчёт одного человека — тем же расчётом, что ночная
 * задача, в запросе (`[решение]` Р-35.6: партия из одного человека — три запроса, очередь ради неё
 * лишь откладывала бы ответ). Не чаще раза в час — `429 recalc_too_often`; уволенному значение
 * зафиксировано (§7.2) — `409 person_archived`. Пересчёт чужого индекса — запись в `audit_log`.
 */
export async function recalcPersonEngagement(access: Access, personId: string): Promise<EngagementResult> {
  return withTenant(access.tenantId, access.userId, async (tx) => {
    const subject = await cardSubject(tx, personId)
    if (!subject) return { ok: false as const, code: 'not_found' as const }
    const scope = await scopeOf(access, subject)
    if (scope === 'none') return { ok: false as const, code: 'forbidden' as const }
    if (subject.archived) return { ok: false as const, code: 'person_archived' as const }
    const [fresh] = await tx.execute(sql`select rating_updated_at > now() - make_interval(mins => ${ENGAGEMENT_RECALC_COOLDOWN_MINUTES}::int) as recent, rating_pct::float8 as before
      from users where id = ${subject.id}::uuid for update`) as unknown as { recent: boolean | null, before: number | null }[]
    if (fresh?.recent) return { ok: false as const, code: 'recalc_too_often' as const }
    const win = await calcWindow(tx, access.tenantId)
    const r = computeEngagementIndex((await collectInputs(tx, [subject.id], win)).get(subject.id)!)
    await writeResult(tx, access.tenantId, subject.id, win, r)
    if (scope !== 'self') {
      await recordAudit(tx, { tenantId: access.tenantId, actorId: access.userId, action: 'person_rating.recalc', entity: 'user', entityId: subject.id, before: { ratingPct: fresh?.before ?? null }, after: { ratingPct: r?.total ?? null } })
    }
    return { ok: true as const, data: await buildView(tx, subject, scope === 'self') }
  })
}

/** Для тестов и задач одного человека вне запроса — тот же расчёт без проверки прав. */
export async function recalcEngagementFor(ctx: Ctx, userIds: string[]): Promise<Map<string, IndexResult | null>> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const win = await calcWindow(tx, ctx.tenantId)
    const inputs = await collectInputs(tx, userIds, win)
    const out = new Map<string, IndexResult | null>()
    for (const id of userIds) {
      const r = computeEngagementIndex(inputs.get(id)!)
      await writeResult(tx, ctx.tenantId, id, win, r)
      out.set(id, r)
    }
    return out
  })
}

export interface EngagementReportRow {
  userId: string
  fullName: string
  location: string | null
  basePct: number
  bonusEarly: number
  bonusStreak: number
  bonusHelp: number
  totalPct: number
  calcDate: string
}

/** Первая строка любого файла отчёта (`38` §9 п. 5, §7.3). */
export const ENGAGEMENT_REPORT_DISCLAIMER = 'Показник довідковий, не призначений для кадрових рішень'

export interface EngagementReportFilter {
  /** Область смотрящего: `null` — весь тенант, массив — точки (`areaForScope`). */
  scope: string[] | null
  locationId?: string
  q?: string
}

/**
 * «Індекс залученості» (`38` §9 п. 5): ПІБ · Точка · Основа · Достроковість · Регулярність · Внесок ·
 * Разом — текущий снимок человека. Каркас людей — `frameWhere()` (только сотрудники, без уволенных,
 * область — по **текущей** точке). Скрытые (`is_hidden`) не входят — индекс скрытого не попадает в
 * сравнения (§7.2). `[решение]` Р-38.6: порядок — по ПІБ, а не по индексу, и колонки «місце» нет:
 * отсортированный по цифре список людей и есть «ранжированный список, топ и антитоп», запрещённый
 * §7.3 обеим сторонам таблицы; сортировать файл по «Разом» человек может сам, но продукт ранжирования
 * не предлагает. Показ и выгрузка — отдельные права (`GET /reports/rating`, конструктор).
 */
export async function engagementIndexRows(ctx: Ctx, f: EngagementReportFilter): Promise<EngagementReportRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select u.id::text as user_id, u.full_name, l.name as location, prs.calc_date::text as calc_date,
             prs.base_pct::float as base_pct, prs.bonus_early::float as bonus_early,
             prs.bonus_streak::float as bonus_streak, prs.bonus_help::float as bonus_help,
             prs.total_pct::float as total_pct
        from person_rating_snapshots prs
        join users u on u.id = prs.user_id
        ${frameJoins()}
       where prs.is_current and not u.is_hidden
         ${frameWhere({ kind: 'employee', scope: f.scope, q: f.q })}
         ${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}
       order by u.full_name, u.id`) as unknown as {
      user_id: string, full_name: string, location: string | null, calc_date: string, base_pct: number, bonus_early: number,
      bonus_streak: number, bonus_help: number, total_pct: number
    }[]
    return rows.map(r => ({
      userId: r.user_id, fullName: r.full_name, location: r.location, basePct: r.base_pct, bonusEarly: r.bonus_early,
      bonusStreak: r.bonus_streak, bonusHelp: r.bonus_help, totalPct: r.total_pct, calcDate: r.calc_date,
    }))
  })
}

/**
 * Для конструктора выгрузок (`reportBuilder.ts`, П-22): «вигружується тільки з явною галкою»
 * (`38` §9 п. 5) — без `confirmed` намеренно пусто, а не данные.
 */
export async function engagementIndexReport(ctx: Ctx, confirmed: boolean, scope: string[] | null = null): Promise<EngagementReportRow[]> {
  if (!confirmed) return []
  return engagementIndexRows(ctx, { scope })
}

/** Плоские строки файла: первая — предупреждение §7.3, дальше — колонки §9 п. 5. */
export function engagementExportRows(rows: EngagementReportRow[]): Record<string, unknown>[] {
  const disclaimer = { full_name: ENGAGEMENT_REPORT_DISCLAIMER, location: '', base_pct: '', bonus_early: '', bonus_streak: '', bonus_help: '', total_pct: '' }
  return [disclaimer, ...rows.map(r => ({
    full_name: r.fullName, location: r.location ?? '', base_pct: r.basePct, bonus_early: r.bonusEarly,
    bonus_streak: r.bonusStreak, bonus_help: r.bonusHelp, total_pct: r.totalPct,
  }))]
}

// ── Ретро-расчёт (`38` §5.3 «динамика за 12 месяцев», §7.2) ─────────────────────────────────

/** На сколько прошлых месяцев восстанавливается динамика — столько показывает экран расшифровки. */
export const ENGAGEMENT_BACKFILL_MONTHS = 12

export interface BackfillStats { months: number, people: number, written: number, skipped: number }

/** Окно на прошедшую дату `calcDate` (последний день месяца в календаре тенанта) и конец этого дня как момент. */
async function calcWindowAt(tx: TenantTx, tenantId: string, calcDate: string): Promise<CalcWindow & { toTs: string }> {
  const [w] = await tx.execute(sql`
    select (d - ${ENGAGEMENT_WINDOW_DAYS - 1}::int)::text as window_from,
           to_char(((d - ${ENGAGEMENT_WINDOW_DAYS - 1}::int)::timestamp at time zone tz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as from_ts,
           to_char(((d + 1)::timestamp at time zone tz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as to_ts
    from (select ${calcDate}::date as d, coalesce(t.timezone, 'Europe/Kyiv') as tz from tenants t where t.id = ${tenantId}::uuid) x`) as unknown as { window_from: string, from_ts: string, to_ts: string }[]
  if (!w) throw new Error(`engagement: тенант ${tenantId} не найден`)
  return { calcDate, from: w.window_from, fromTs: w.from_ts, toTs: w.to_ts }
}

/**
 * Входы формулы «как было» на конец прошедшего дня. Записи на курс восстанавливаются по датам:
 * заведена и открыта к этому дню, срок или завершение в окне, либо не завершена к этому дню.
 * `[решение]` Р-38.7: исторического процента прохождения нет — у записи, завершённой позже даты
 * расчёта, `cᵢ` берётся как у ещё не начатой (0), а статус — «в процессе», если она уже была
 * начата; снятые записи не входят, как и в ежедневном расчёте (момент снятия в статусе не
 * сохраняется). Серия и помощь — из суточного агрегата ленты: он бессрочный, но начинается с
 * выкатки PR-34, поэтому ранние месяцы честно получают `S` и `H` по нулям.
 */
async function collectInputsAt(tx: TenantTx, ids: readonly string[], win: CalcWindow & { toTs: string }): Promise<Map<string, IndexInput>> {
  const out = new Map<string, IndexInput>(ids.map(id => [id, { enrollments: [], longestStreak: 0, help: { reviews: 0, issues: 0 } }]))
  if (!ids.length) return out
  const rows = await tx.execute(sql`
    select e.id::text as enrollment_id, e.user_id::text as user_id, e.subject_id::text as subject_id,
           c.title, coalesce(a.is_mandatory, false) as mandatory, e.status, e.started_at,
           greatest(e.created_at, coalesce(e.starts_at, e.created_at)) as assigned_at, e.due_at, e.completed_at,
           ls.capabilities
      from enrollments e
      join courses c on c.id = e.subject_id
      left join lifecycle_stages ls on ls.id = c.lifecycle_stage_id
      left join assignments a on a.id = e.assignment_id
     where e.user_id in ${ids}
       and e.cancelled_at is null
       and e.status in ('not_started', 'in_progress', 'done', 'failed')
       and e.created_at < ${win.toTs}::timestamptz
       and (e.starts_at is null or e.starts_at < ${win.toTs}::timestamptz)
       and (   (e.due_at >= ${win.fromTs}::timestamptz and e.due_at < ${win.toTs}::timestamptz)
            or (e.completed_at >= ${win.fromTs}::timestamptz and e.completed_at < ${win.toTs}::timestamptz)
            or e.completed_at is null or e.completed_at >= ${win.toTs}::timestamptz)
     order by e.created_at, e.id`) as unknown as {
    enrollment_id: string, user_id: string, subject_id: string, title: string, mandatory: boolean, status: string,
    started_at: Date | string | null, assigned_at: Date | string, due_at: Date | string | null, completed_at: Date | string | null,
    capabilities: StageCapabilityMap | null
  }[]
  const end = Date.parse(win.toTs)
  for (const r of rows) {
    if (!stageCan(r.capabilities ? { capabilities: r.capabilities } : null, 'counts_in_rating')) continue
    const doneThen = r.completed_at !== null && new Date(r.completed_at).getTime() < end
    const startedThen = r.started_at !== null && new Date(r.started_at).getTime() < end
    const e: IndexEnrollment = {
      enrollmentId: r.enrollment_id,
      subjectId: r.subject_id,
      title: r.title,
      mandatory: r.mandatory,
      status: doneThen ? r.status : startedThen ? 'in_progress' : 'not_started',
      progressPct: doneThen ? 100 : 0,
      assignedAt: iso(r.assigned_at)!,
      dueAt: iso(r.due_at),
      completedAt: doneThen ? iso(r.completed_at) : null,
    }
    ;(out.get(r.user_id)!.enrollments as IndexEnrollment[]).push(e)
  }
  await activityInputs(tx, ids, win, out)
  return out
}

/**
 * Ретро-расчёт индекса (§7.2, «динамика за 12 месяцев» §5.3): снимок на последний день каждого из
 * 12 прошедших месяцев — тем же `computeEngagementIndex()`, по данным «как было» (Р-38.7). Пишется
 * **только** туда, где в этом месяце у человека нет ни одного снимка: настоящий ночной снимок
 * главнее восстановленного, повторный запуск ничего не меняет. `is_current` и `users.rating_pct`
 * не трогаются — текущая цифра остаётся за `rating.recalc`. Отметка `breakdown.retro = true` —
 * экран и выгрузка ПД видят, что число восстановлено. Сотрудники, кроме уволенных, партиями по 500.
 */
export async function backfillTenantEngagement(tenantId: string, months = ENGAGEMENT_BACKFILL_MONTHS): Promise<BackfillStats> {
  const stats: BackfillStats = { months: 0, people: 0, written: 0, skipped: 0 }
  const dates = await withTenant(tenantId, null, async tx => (await tx.execute(sql`
    select (date_trunc('month', (now() at time zone coalesce(t.timezone, 'Europe/Kyiv'))::date) - make_interval(months => g - 1) - interval '1 day')::date::text as d
      from tenants t, generate_series(1, ${months}::int) g where t.id = ${tenantId}::uuid order by d`) as unknown as { d: string }[]).map(r => r.d))
  stats.months = dates.length
  for (const calcDate of dates) {
    let after = '00000000-0000-0000-0000-000000000000'
    for (;;) {
      const n = await withTenant(tenantId, null, async (tx) => {
        const batch = await employees(tx, { id: users.id }, ne(users.status, 'archived'), gt(users.id, after))
          .orderBy(users.id).limit(ENGAGEMENT_BATCH_SIZE)
        if (!batch.length) return 0
        after = batch[batch.length - 1]!.id
        const month = calcDate.slice(0, 7)
        const have = new Set((await tx.execute(sql`
          select distinct user_id::text as user_id from person_rating_snapshots
           where user_id in ${batch.map(b => b.id)} and to_char(calc_date, 'YYYY-MM') = ${month}`) as unknown as { user_id: string }[]).map(r => r.user_id))
        const ids = batch.map(b => b.id).filter(id => !have.has(id))
        stats.skipped += batch.length - ids.length
        const win = await calcWindowAt(tx, tenantId, calcDate)
        const inputs = await collectInputsAt(tx, ids, win)
        for (const id of ids) {
          stats.people++
          const r = computeEngagementIndex(inputs.get(id)!)
          if (!r) continue
          await tx.execute(sql`
            insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
            values (${tenantId}::uuid, ${id}::uuid, ${calcDate}::date, ${r.base}, ${r.early}, ${r.streak}, ${r.help}, ${r.total},
                    ${JSON.stringify({ ...r.breakdown, retro: true })}::jsonb, ${win.from}::date, ${calcDate}::date, false)
            on conflict (tenant_id, user_id, calc_date) do nothing`)
          stats.written++
        }
        return batch.length
      })
      if (n < ENGAGEMENT_BATCH_SIZE) break
    }
  }
  return stats
}

/** След выгрузки отчёта и запуска ретро-расчёта в `audit_log` (CLAUDE.md п. 14: `request_context` — там же). */
export async function auditEngagement(ctx: { tenantId: string, actorId: string }, action: 'report.rating.export' | 'person_rating.backfill', after: Record<string, unknown>): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action, entity: 'person_rating_snapshots', entityId: null, after }))
}
