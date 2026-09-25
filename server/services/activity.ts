import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { ACTIVITY_LEVEL_BOUNDS, ACTIVITY_RETENTION_DAYS, REVIEWER_ACTIVITY_DAYS } from '../../shared/domain/activity'
import type { ActivityDay, ActivityLevel } from '../../shared/domain/activity'
import type { UserActivityKind } from '../../shared/enums'
import type { Access } from './access'
import { areaCovers, areaOf, can } from './access'
import { cardSubject } from './personCard'
import type { CardSubject } from './personCard'

/**
 * Лента и карта активности человека (docs/v2/38-people-extensions.md §3.3, §5.1, §7.9–§7.11, §11;
 * PR-34). Единственный писатель `user_activity_events` и `user_activity_daily`.
 *
 * **Пояс человека — одна цепочка на весь продукт** (`personTimezone()`, §7.10): `users.timezone`
 * (override для удалённых) → пояс точки, где человек работал на дату события (активное
 * размещение, основное — первым) → пояс точки вакансии, на которую откликнулся кандидат (PR-37:
 * у кандидата размещений нет) → пояс тенанта. По ней же считают тихие часы уведомлений
 * (`enqueueNotification()`), чтобы «его ночь» и «его день» не расходились между модулями.
 *
 * **Локальный день считается один раз** — в момент вставки события, по снимку пояса, и больше не
 * пересчитывается: перевод на точку в другом поясе не переписывает прошлую карту (§7.10, §12).
 * Граница суток — полночь человека, не UTC и не тенанта: событие в 22:40 UTC у человека на UTC+4
 * ложится в следующий день (критерий 11).
 *
 * **Агрегат** обновляется в той же транзакции, что и событие (счётчик, разбивка, уровень), —
 * карта видит событие сразу, а не через час. Секунды дня — не из события, а из сегментов учёта
 * времени биениями (`learning_time_sessions`, PR-21): их сводит задача `activity.aggregate`.
 * Писатели трогают разные колонки, поэтому не перетирают друг друга. События живут 400 дней
 * (`activity.purge`), агрегат — бессрочно: уборка не трогает ни строки агрегата (критерий 12).
 */

const DEFAULT_TZ = 'Europe/Kyiv'

/** `case` уровня по числу событий — та же лесенка, что `activityLevel()` (`shared/domain/activity.ts`). */
export function levelSql(count: SQL): SQL {
  const [l1, l2, l3] = ACTIVITY_LEVEL_BOUNDS
  return sql`(case when ${count} <= 0 then 0 when ${count} <= ${sql.raw(String(l1))} then 1 when ${count} <= ${sql.raw(String(l2))} then 2 when ${count} <= ${sql.raw(String(l3))} then 3 else 4 end)::smallint`
}

/**
 * Строка «пояс человека на момент `at`»: `tz`, точка (`location_id`) и откуда взят пояс
 * (`source`). Размещение ищется на календарную дату `at` в поясе тенанта — даты размещений
 * вносятся в его календаре; в день перевода действует новое (`started_at desc`).
 * Кандидату — точка вакансии: размещений у него нет (PR-37 брал её для тихих часов).
 */
function personTzRow(userId: SQL, at: SQL): SQL {
  return sql`
    select coalesce(u.timezone, pl.timezone, vl.timezone, t.timezone, ${DEFAULT_TZ}) as tz,
           coalesce(pl.location_id, vl.id) as location_id,
           case when u.timezone is not null then 'user' when pl.timezone is not null then 'placement'
                when vl.timezone is not null then 'vacancy' when t.timezone is not null then 'tenant' else 'default' end as source
    from users u
    join tenants t on t.id = u.tenant_id
    left join lateral (
      select up.location_id, l.timezone from user_placements up join locations l on l.id = up.location_id
      where up.user_id = u.id
        and up.started_at <= (${at} at time zone t.timezone)::date
        and (up.ended_at is null or up.ended_at >= (${at} at time zone t.timezone)::date)
      order by up.is_primary desc, up.started_at desc, up.created_at desc
      limit 1
    ) pl on true
    left join vacancies v on v.id = u.vacancy_id and u.kind = 'candidate'
    left join locations vl on vl.id = v.location_id
    where u.id = ${userId}`
}

export type TimezoneSource = 'user' | 'placement' | 'vacancy' | 'tenant' | 'default'

export interface PersonTimezone {
  tz: string
  locationId: string | null
  source: TimezoneSource
}

/** Пояс человека на момент `at` (по умолчанию — сейчас). Человека нет — пояс по умолчанию. */
export async function personTimezone(tx: TenantTx, userId: string, at?: Date): Promise<PersonTimezone> {
  const moment = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`
  const [row] = await tx.execute(personTzRow(sql`${userId}::uuid`, moment)) as unknown as { tz: string, location_id: string | null, source: TimezoneSource }[]
  return row ? { tz: row.tz, locationId: row.location_id, source: row.source } : { tz: DEFAULT_TZ, locationId: null, source: 'default' }
}

export interface ActivityInput {
  userId: string
  kind: UserActivityKind
  /** Источник события — мягкая ссылка (`44` В-11): имя таблицы и строка в ней. */
  ref?: { entity: string, id: string | null }
  /**
   * Момент действия самого человека, если он раньше записи (Р-34.3): оценка попытки ложится в
   * день сдачи, принятое замечание — в день жалобы. По умолчанию — сейчас.
   */
  occurredAt?: Date | null
}

/**
 * Записывает событие ленты в транзакции действия и обновляет агрегат его дня.
 *
 * Запись вторична по отношению к действию: она идёт в точке сохранения, и сбой (например, пояс,
 * которого Postgres не знает, в данных точки) не откатывает зачёт урока или сдачу попытки —
 * только теряет одно событие карты с записью в лог. Возвращает локальный день события
 * (`YYYY-MM-DD`) или `null`, если записать не удалось.
 */
export async function recordActivity(tx: TenantTx, tenantId: string, input: ActivityInput): Promise<string | null> {
  // Момент из прошлого берётся как есть, из будущего (часы устройства офлайн-прогона) — не
  // берётся: клетка «завтра» на карте была бы неправдой
  const past = input.occurredAt && input.occurredAt.getTime() < Date.now() ? input.occurredAt : null
  const at = past ? sql`${past.toISOString()}::timestamptz` : sql`now()`
  try {
    return await tx.transaction(async (sp) => {
      const rows = await sp.execute(sql`
        with z as (${personTzRow(sql`${input.userId}::uuid`, at)}),
        ev as (
          insert into user_activity_events (tenant_id, user_id, kind, ref_entity, ref_id, location_id, tz, local_date, occurred_at)
          select ${tenantId}::uuid, ${input.userId}::uuid, ${input.kind}, ${input.ref?.entity ?? null}, ${input.ref?.id ?? null}::uuid,
                 z.location_id, z.tz, (${at} at time zone z.tz)::date, ${at}
          from z
          returning local_date
        )
        insert into user_activity_daily as d (tenant_id, user_id, local_date, events_count, kinds, level)
        select ${tenantId}::uuid, ${input.userId}::uuid, ev.local_date, 1, jsonb_build_object(${input.kind}::text, 1), ${levelSql(sql`1`)}
        from ev
        on conflict (tenant_id, user_id, local_date) do update set
          events_count = d.events_count + 1,
          kinds = jsonb_set(d.kinds, array[${input.kind}::text], to_jsonb(coalesce((d.kinds ->> ${input.kind}::text)::int, 0) + 1)),
          level = ${levelSql(sql`d.events_count + 1`)},
          recalced_at = now()
        returning d.local_date::text as local_date`) as unknown as { local_date: string }[]
      return rows[0]?.local_date ?? null
    })
  }
  catch (err) {
    console.error(`activity ${input.kind} for ${input.userId} not recorded`, err)
    return null
  }
}

// ── Кто видит ленту (§2, §7.11) ─────────────────────────────────────────────────────────

/**
 * Как смотрящий видит ленту человека:
 *  - `self` — своя лента, скоуп не нужен (§2: «свою — все роли»);
 *  - `full` — `person.activity.view_others` на весь тенант (HR, администратор) или в области,
 *    покрывающей **текущую** точку человека (руководитель точки; при переводе доступ прежнего
 *    пропадает в тот же день — то же понятие «своих точек», что у заметок PR-32);
 *  - `reviewer` — проверяющий (`review.grade`), у которого работа человека сейчас в очереди:
 *    назначена ему, делегирована, эскалирована на него или открыта им. Видит 90 дней. Это право
 *    по данным, а не скоуп (Р-34.5): скоуп наставника на точку открыл бы ему всю точку целиком;
 *  - `none` — `403`.
 * Токен интеграции прав по данным не получает — только скоуп (как заметки, `docs/v2/44` В-20).
 */
export type ActivityScope = 'self' | 'full' | 'reviewer' | 'none'

async function scopeOf(tx: TenantTx, access: Access, subject: CardSubject): Promise<ActivityScope> {
  const viaToken = access.viaToken === true
  if (!viaToken && access.userId === subject.id) return 'self'
  if (areaCovers(await areaOf(access, 'person.activity.view_others'), subject.locationId)) return 'full'
  if (viaToken || !can(access, 'review.grade')) return 'none'
  const [held] = await tx.execute(sql`
    select 1 from review_queue_items q
    where q.user_id = ${subject.id}::uuid and q.status <> 'done'
      and (q.assigned_reviewer_id = ${access.userId}::uuid or q.claimed_by = ${access.userId}::uuid
           or (q.escalated_at is not null and q.escalated_to_id = ${access.userId}::uuid))
    limit 1`) as unknown as unknown[]
  return held ? 'reviewer' : 'none'
}

export interface PersonActivityYear {
  year: number
  /** Годы селектора: с первого дня с активностью (или начала окна наставника) до текущего. */
  years: number[]
  /** Пояс человека сейчас — подпись «дні — за часом людини». Дни прошлого считаны по снимкам. */
  timezone: string
  /** Окно, доступное смотрящему: `from` — начало (у наставника — 90 дней назад), `to` — сегодня человека. */
  window: { from: string | null, to: string }
  scope: Exclude<ActivityScope, 'none'>
  days: ActivityDay[]
  totals: { activeDays: number, events: number, seconds: number }
}

export type PersonActivityResult = { ok: true, data: PersonActivityYear } | { ok: false, code: 'not_found' | 'forbidden' }

/**
 * `GET /people/:id/activity?year=` — «дні · події · рівні за рік» (§5.1, §10). Карта строится
 * по агрегату, а не по событиям: он хранится бессрочно, и год, чьи события уже убраны
 * `activity.purge`, рисуется так же, как текущий (критерий 12). Человек карточки — только
 * сотрудник (`cardSubject()`): кандидат и чужой тенант — `404`.
 */
export async function personActivityYear(access: Access, personId: string, query: { year?: number }): Promise<PersonActivityResult> {
  return withTenant(access.tenantId, access.userId, async (tx) => {
    const subject = await cardSubject(tx, personId)
    if (!subject) return { ok: false as const, code: 'not_found' as const }
    const scope = await scopeOf(tx, access, subject)
    if (scope === 'none') return { ok: false as const, code: 'forbidden' as const }

    const zone = await personTimezone(tx, subject.id)
    const [bounds] = await tx.execute(sql`
      select (now() at time zone ${zone.tz})::date::text as today,
             ((now() at time zone ${zone.tz})::date - ${REVIEWER_ACTIVITY_DAYS - 1}::int)::text as reviewer_from,
             (select min(local_date)::text from user_activity_daily where user_id = ${subject.id}::uuid) as first_day
    `) as unknown as { today: string, reviewer_from: string, first_day: string | null }[]
    const today = bounds!.today
    const from = scope === 'reviewer' ? bounds!.reviewer_from : null
    const currentYear = Number(today.slice(0, 4))
    const firstYear = Math.min(currentYear, Number((from ?? bounds!.first_day ?? today).slice(0, 4)))
    const years = Array.from({ length: currentYear - firstYear + 1 }, (_, i) => currentYear - i)
    const year = query.year ?? currentYear

    const rows = await tx.execute(sql`
      select local_date::text as date, events_count as count, seconds_spent as seconds, level, kinds
      from user_activity_daily
      where user_id = ${subject.id}::uuid
        and local_date between make_date(${year}::int, 1, 1) and make_date(${year}::int, 12, 31)
        ${from ? sql`and local_date >= ${from}::date` : sql``}
        and (events_count > 0 or seconds_spent > 0)
      order by local_date`) as unknown as { date: string, count: number, seconds: number, level: number, kinds: Record<string, number> }[]
    const days: ActivityDay[] = rows.map(r => ({ date: r.date, count: r.count, seconds: r.seconds, level: r.level as ActivityLevel, kinds: r.kinds }))
    return {
      ok: true as const,
      data: {
        year,
        years,
        timezone: zone.tz,
        window: { from, to: today },
        scope,
        days,
        totals: {
          activeDays: days.filter(d => d.level > 0).length,
          events: days.reduce((s, d) => s + d.count, 0),
          seconds: days.reduce((s, d) => s + d.seconds, 0),
        },
      },
    }
  })
}

// ── Фоновые задачи (§11) ────────────────────────────────────────────────────────────────

/**
 * `activity.purge` — ежесуточно 03:00: события старше 400 дней удаляются физически (§7.11).
 * Агрегат не трогается — он и есть карта прошлых лет (критерий 12).
 */
export async function purgeActivity(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const gone = await tx.execute(sql`
      delete from user_activity_events
      where tenant_id = ${tenantId}::uuid and occurred_at < now() - make_interval(days => ${ACTIVITY_RETENTION_DAYS}::int)
      returning id`) as unknown as unknown[]
    return gone.length
  })
}

/**
 * `activity.aggregate` — секунды дня в агрегат из сегментов учёта времени (PR-21, `37` §7.10):
 * «{HH:MM} у навчанні» в подсказке клетки. Время не копируется в события и не меряется заново —
 * берутся зачтённые секунды сегментов, начатых в локальный день человека (Р-34.2).
 *
 * Пересчитываются только дни, чьи сегменты менялись за окно: ежечасно — 120 минут, раз в сутки —
 * 48 часов (поздние закрытия зависших сегментов и сбой задачи на пару часов, как у `time.rollup`).
 * День пересчитывается целиком из всех своих сегментов — прогон идемпотентен. Старые дни окно
 * не задевает, поэтому уборка сегментов в будущем (`time.purge_sessions`) их не обнулит.
 */
export async function aggregateActivitySeconds(tenantId: string, opts: { windowMinutes?: number } = {}): Promise<{ days: number }> {
  const window = Math.max(1, Math.floor(opts.windowMinutes ?? 120))
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      with touched as (
        select distinct s.user_id from learning_time_sessions s
        where s.updated_at >= now() - make_interval(mins => ${window}::int)
      ),
      zone as (
        select touched.user_id, z.tz from touched cross join lateral (${personTzRow(sql`touched.user_id`, sql`now()`)}) z
      ),
      days as (
        select distinct s.user_id, (s.started_at at time zone zone.tz)::date as local_date, zone.tz
        from learning_time_sessions s join zone on zone.user_id = s.user_id
        where s.updated_at >= now() - make_interval(mins => ${window}::int)
      ),
      sums as (
        select days.user_id, days.local_date, coalesce(sum(s.credited_seconds), 0)::int as seconds
        from days join learning_time_sessions s on s.user_id = days.user_id
          and s.started_at >= (days.local_date::timestamp at time zone days.tz)
          and s.started_at < ((days.local_date + 1)::timestamp at time zone days.tz)
        group by days.user_id, days.local_date
      )
      insert into user_activity_daily as d (tenant_id, user_id, local_date, seconds_spent)
      select ${tenantId}::uuid, sums.user_id, sums.local_date, sums.seconds from sums
      on conflict (tenant_id, user_id, local_date) do update
        set seconds_spent = excluded.seconds_spent, recalced_at = now()
        where d.seconds_spent is distinct from excluded.seconds_spent
      returning d.id`) as unknown as unknown[]
    return { days: rows.length }
  })
}
