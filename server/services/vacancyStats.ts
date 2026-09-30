import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { VACANCY_STATS_ROLLUP_DAYS } from '../../shared/enums'

/**
 * `vacancy.stats_rollup` — ежечасно (`docs/v2/29-vacancies.md` §11; отчёты §9.1, §9.4;
 * решение `v2/44` Р-VT.3).
 *
 * Журнал `public_apply_attempts` живёт 30 дней (`vacancy.attempts_gc`), а «просмотров» в
 * отчёте эффективности вакансии и «заблокировано / топ-5 причин» в отчёте защиты страниц
 * нужны за любой период. Свёртка переносит их в `vacancy_stats_daily` — строка «вакансия ×
 * сутки по поясу тенанта».
 *
 * Пересчёт полный, а не приращением: каждый прогон заново считает последние
 * `VACANCY_STATS_ROLLUP_DAYS` суток целиком (`insert … on conflict do update`), поэтому
 * пропущенный прогон догоняется следующим, а повторный ничего не удваивает. Окно короче срока
 * журнала на сутки: день, который уборка уже начала срезать, больше не пересчитывается и
 * остаётся таким, каким его увидел последний полный прогон.
 */
export async function vacancyStatsRollupTenant(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      with tz as (select timezone as zone from tenants where id = ${tenantId}::uuid),
      src as (
        select a.vacancy_id, (a.created_at at time zone (select zone from tz))::date as day, a.outcome, a.reason
          from public_apply_attempts a
         where a.vacancy_id is not null
           and (a.created_at at time zone (select zone from tz))::date
               > (now() at time zone (select zone from tz))::date - ${VACANCY_STATS_ROLLUP_DAYS}::int
      ),
      reasons as (
        select vacancy_id, day, jsonb_object_agg(reason, n) as block_reasons
          from (select vacancy_id, day, coalesce(reason, 'other') as reason, count(*)::int as n
                  from src where outcome = 'submit_blocked' group by 1, 2, 3) r
         group by 1, 2
      ),
      agg as (
        select vacancy_id, day,
               count(*) filter (where outcome = 'view')::int as views,
               count(*) filter (where outcome = 'submit_ok')::int as submits,
               count(*) filter (where outcome = 'submit_blocked')::int as blocked
          from src group by 1, 2
      )
      insert into vacancy_stats_daily (tenant_id, vacancy_id, day, views, submits, blocked, block_reasons, updated_at)
      select ${tenantId}::uuid, agg.vacancy_id, agg.day, agg.views, agg.submits, agg.blocked,
             coalesce(reasons.block_reasons, '{}'::jsonb), now()
        from agg left join reasons using (vacancy_id, day)
      on conflict (tenant_id, vacancy_id, day) do update
         set views = excluded.views, submits = excluded.submits, blocked = excluded.blocked,
             block_reasons = excluded.block_reasons, updated_at = excluded.updated_at
      returning vacancy_id
    `) as unknown as { vacancy_id: string }[]
    return rows.length
  })
}
