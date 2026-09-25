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

  return out
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
