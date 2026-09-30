import { sql } from 'drizzle-orm'
import { platformDb } from '../platform'
import type { AiOperatorMetricsQuery } from '../../../shared/schemas/ai'

/**
 * Журнал ИИ для оператора платформы — **только метрики** (`docs/v2/30-ai-interview.md` §2:
 * «Журнал ИИ-вызовов: содержимое | только метрики», оператору — вторая колонка; `44` Р-AI2.4).
 *
 * Оператору доступны `latency_ms`, `tokens_*`, `cost_minor`, `status`, `model_name` — «хватает на
 * разбор аварии и счёт, не хватает на чтение чужих ответов». Поэтому здесь нет ни одной колонки,
 * которая ведёт к человеку или к содержимому: ни `output`, ни `input_ref`/`input_digest`, ни
 * `ref_id`, ни `subject_user_id`/`actor_user_id`, ни `prompt_key`. Строки — агрегаты по тенанту,
 * роли вызова и модели; отдельного вызова оператор не видит (по одной строке с `ref_kind` и
 * временем можно было бы сопоставить вызов с человеком).
 *
 * Читается ролью `platform_admin` (BYPASSRLS, docs/02 §2.12) — единственный путь через все тенанты.
 */

export interface AiOperatorMetricRow {
  tenantId: string
  tenantName: string
  purpose: string
  modelName: string
  currency: string
  calls: number
  ok: number
  failed: number
  timeout: number
  refused: number
  degraded: number
  errorPct: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  tokensIn: number
  tokensOut: number
  costMinor: number
}

export interface AiOperatorMetrics {
  from: string
  to: string
  rows: AiOperatorMetricRow[]
  /** Итог по валютам — суммы разных валют не складываются. */
  totals: { currency: string, calls: number, errors: number, costMinor: number }[]
}

/** Период по умолчанию — последние 30 дней включая сегодня (UTC: у оператора нет пояса тенанта). */
export const OPERATOR_METRICS_DAYS = 30

export async function aiOperatorMetrics(q: AiOperatorMetricsQuery, now = new Date()): Promise<AiOperatorMetrics> {
  const to = q.to ?? now.toISOString().slice(0, 10)
  const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - (OPERATOR_METRICS_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
  const rows = await platformDb().execute(sql`
    select c.tenant_id, t.name as tenant_name, c.purpose, c.model_name, c.currency,
           count(*)::int as calls,
           count(*) filter (where c.status = 'ok')::int as ok,
           count(*) filter (where c.status = 'failed')::int as failed,
           count(*) filter (where c.status = 'timeout')::int as timeout,
           count(*) filter (where c.status = 'refused')::int as refused,
           count(*) filter (where c.status = 'degraded')::int as degraded,
           avg(c.latency_ms) as avg_latency,
           percentile_cont(0.95) within group (order by c.latency_ms) as p95_latency,
           coalesce(sum(c.tokens_in), 0)::bigint::float8 as tokens_in,
           coalesce(sum(c.tokens_out), 0)::bigint::float8 as tokens_out,
           coalesce(sum(c.cost_minor), 0)::bigint::float8 as cost
      from ai_calls c join tenants t on t.id = c.tenant_id
     where c.created_at >= ${from}::date and c.created_at < ${to}::date + 1
       ${q.tenantId ? sql`and c.tenant_id = ${q.tenantId}::uuid` : sql``}
       ${q.purpose ? sql`and c.purpose = ${q.purpose}` : sql``}
     group by c.tenant_id, t.name, c.purpose, c.model_name, c.currency
     order by t.name, c.purpose, c.model_name, c.currency`) as unknown as {
    tenant_id: string, tenant_name: string, purpose: string, model_name: string, currency: string, calls: number, ok: number, failed: number,
    timeout: number, refused: number, degraded: number, avg_latency: string | null, p95_latency: number | null, tokens_in: number, tokens_out: number, cost: number
  }[]
  const out: AiOperatorMetricRow[] = rows.map(r => ({
    tenantId: r.tenant_id, tenantName: r.tenant_name, purpose: r.purpose, modelName: r.model_name, currency: r.currency,
    calls: r.calls, ok: r.ok, failed: r.failed, timeout: r.timeout, refused: r.refused, degraded: r.degraded,
    // Ошибка — провайдер не справился (`failed`, `timeout`); отказ по подписке и деградация — не ошибка модели (Р-AI.6)
    errorPct: r.calls ? Math.round((r.failed + r.timeout) / r.calls * 1000) / 10 : null,
    avgLatencyMs: r.avg_latency === null ? null : Math.round(Number(r.avg_latency)),
    p95LatencyMs: r.p95_latency === null ? null : Math.round(Number(r.p95_latency)),
    tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), costMinor: Number(r.cost),
  }))
  const totals = new Map<string, { currency: string, calls: number, errors: number, costMinor: number }>()
  for (const r of out) {
    const t = totals.get(r.currency) ?? { currency: r.currency, calls: 0, errors: 0, costMinor: 0 }
    t.calls += r.calls
    t.errors += r.failed + r.timeout
    t.costMinor += r.costMinor
    totals.set(r.currency, t)
  }
  return { from, to, rows: out, totals: [...totals.values()] }
}
