import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { usageCounters, usageEvents } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { LIMIT_AXES, type LimitAxis, type UsageRefKind } from '../../shared/enums'
import { GIB, checkLimit, effectiveLimit, effectiveLimits, type LimitCheck } from './tenantLimits'
import { EMPLOYEES_ONLY, CANDIDATES_ONLY } from './repo/people'

/**
 * Учёт потребления по одиннадцати осям (docs/v2/35-billing-limits.md §7.1, §7.5, §3.5;
 * план docs/v2/45 PR-09, патч П-25.2).
 *
 * **Один источник истины о лимите.** Квоту считает только `effectiveLimits()` из
 * `tenantLimits.ts` (PR-08, решение docs/v2/44 В-5). Этот модуль хранит и отдаёт **факт**:
 * счётчик периода `usage_counters`, журнал расхода `usage_events` и снимок лимита на момент
 * открытия периода. Второй формулы квоты здесь нет ни одной — иначе панель оператора, баннер
 * и счёт снова разошлись бы числами, ровно как до PR-08.
 *
 * **Счётчики пополняются в тех же точках, где уже есть проверка лимита** (условие плана):
 * `media.createUploadUrl` (ось `storage_bytes`), `channels.sendSms` (`sms_out`),
 * `webhooks.createEndpoint` / `deleteEndpoint` (`integrations_active`),
 * `platform.checkPlanLimit` (`users_active`, `candidates_active`), `reportExports.runExport`
 * (`export_rows`). Дублирующей логики проверки не заводится: точки зовут `meterOrDegrade()`
 * и `recordUsage()`, а решение «пройдёт или нет» принимает `checkLimit()` из PR-08.
 */

// ── Оси: как считаются и что перестаёт работать при исчерпании ───────────────────────────

/**
 * Жёсткость оси — столбец «Тип» таблицы `35` §7.1, дословно.
 * `hard` — операция отклоняется; `hard_degraded` — операция проходит, но другим путём
 * (дословная формулировка документа «жёсткий с деградацией»); `soft` — только наблюдение.
 */
export type AxisKind = 'hard' | 'hard_degraded' | 'soft'

/**
 * Что именно перестаёт работать при превышении — столбец «При исчерпании» `35` §7.1,
 * переведённый в машинное значение. Ничего сверх документа: значения ровно покрывают
 * одиннадцать строк таблицы, и ни одно не блокирует прохождение обучения (§7.4
 * «Не блокируются никогда», правило `25` §10 сильнее любого счётчика).
 */
export type AxisDegradation =
  | 'reject' /** создание/активация отклоняется, уже созданное работает */
  | 'finish_started' /** новые не запускаются, начатые доводятся до конца (ai_interview_ops) */
  | 'manual_review' /** ИИ-сверка не выполняется, задание идёт в обычную очередь ручной проверки */
  | 'channel_fallback' /** канал SMS отключается, доставка идёт Telegram и in-app (`23` §6) */
  | 'background_job' /** выгрузка уходит в фоновую задачу со ссылкой на файл */
  | 'retry_after' /** `429` с `Retry-After` */
  | 'observe' /** только наблюдение: канал бесплатный, всплеск — признак ошибки в правилах */

/** Откуда берётся факт: моментальный пересчёт по определению оси или накопленный счётчик. */
export type AxisSource = 'live' | 'counter'

export interface AxisMeter {
  kind: AxisKind
  source: AxisSource
  onExhausted: AxisDegradation
  /** Ведётся ли строка журнала расхода и с каким `ref_kind` (`35` §3.5; шесть значений). */
  refKind: UsageRefKind | null
}

/**
 * Таблица `35` §7.1 целиком, строка в строку. Менять её можно только вслед за документом:
 * «правила прохождения — в назначении, поведение лимита — в этой таблице, а не в коде
 * вызывающего» (CLAUDE.md «не выдумывать поля и правила»).
 */
export const AXIS_METER: Record<LimitAxis, AxisMeter> = {
  // моментально: count(users) where status='active' and kind='employee'
  users_active: { kind: 'hard', source: 'live', onExhausted: 'reject', refKind: null },
  // моментально: кандидаты не в архиве и не отклонённые
  candidates_active: { kind: 'hard', source: 'live', onExhausted: 'reject', refKind: null },
  // моментально при загрузке (текущее + размер файла); суточный пересчёт по префиксу t/<tenant_id>/
  storage_bytes: { kind: 'hard', source: 'live', onExhausted: 'reject', refKind: 'upload' },
  ai_generate_ops: { kind: 'hard', source: 'counter', onExhausted: 'reject', refKind: 'ai_generation' },
  ai_review_ops: { kind: 'hard_degraded', source: 'counter', onExhausted: 'manual_review', refKind: 'ai_review' },
  ai_interview_ops: { kind: 'hard', source: 'counter', onExhausted: 'finish_started', refKind: 'ai_interview' },
  sms_out: { kind: 'hard', source: 'counter', onExhausted: 'channel_fallback', refKind: 'sms' },
  telegram_out: { kind: 'soft', source: 'counter', onExhausted: 'observe', refKind: null },
  integrations_active: { kind: 'hard', source: 'live', onExhausted: 'reject', refKind: null },
  // скользящее окно живёт в rateLimit.ts/apiTokens.ts — счётчика периода у оси нет (docs/28)
  api_rate_rpm: { kind: 'hard', source: 'live', onExhausted: 'retry_after', refKind: null },
  export_rows: { kind: 'hard_degraded', source: 'counter', onExhausted: 'background_job', refKind: 'export' },
}

/** Моментальные оси: их счётчик обязан сходиться с прямым пересчётом (сквозная проверка 15 `42` §5). */
export const LIVE_AXES = LIMIT_AXES.filter(a => AXIS_METER[a].source === 'live' && a !== 'api_rate_rpm')

// ── Биллинговый период ──────────────────────────────────────────────────────────────────

export interface BillingWindow { start: string, end: string }

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)
const parse = (s: string) => new Date(`${s}T00:00:00Z`)

function shift(d: Date, months: number): Date {
  const out = new Date(d)
  out.setUTCMonth(out.getUTCMonth() + months)
  return out
}

/**
 * Окно биллингового периода (`35` §7.8 п. 2): месяц или год **от даты подключения**,
 * `paid_until` — последний оплаченный день включительно. Пока тенант не платил (`trial`,
 * `paid_until` пуст), окно — календарный месяц/год: считать «от даты подключения» не от чего,
 * а счётчик нужен с первого дня (§7.5 — проверка идёт по текущему значению, а не по снимку).
 */
export function billingWindow(
  sub: { billingPeriod: 'month' | 'year', paidUntil: string | null },
  today: Date = new Date(),
): BillingWindow {
  const months = sub.billingPeriod === 'year' ? 12 : 1
  const now = parse(iso(today))
  if (!sub.paidUntil) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), months === 12 ? 0 : now.getUTCMonth(), 1))
    return { start: iso(start), end: iso(new Date(shift(start, months).getTime() - DAY)) }
  }
  // Окно, содержащее сегодня: от оплаченного дня катимся периодами вперёд или назад.
  let end = parse(sub.paidUntil)
  let guard = 0
  while (end.getTime() < now.getTime() && guard++ < 1200) end = shift(end, months)
  while (guard++ < 2400) {
    const start = new Date(shift(end, -months).getTime() + DAY)
    if (start.getTime() <= now.getTime()) return { start: iso(start), end: iso(end) }
    end = shift(end, -months)
  }
  return { start: iso(now), end: iso(now) }
}

/** Окно текущего периода тенанта — по состоянию подписки из общей функции лимитов (PR-08). */
export async function currentWindow(tenantId: string, today: Date = new Date()): Promise<BillingWindow> {
  const { subscription } = await effectiveLimits(tenantId)
  return billingWindow(subscription, today)
}

// ── Счётчики ────────────────────────────────────────────────────────────────────────────

/**
 * Открывает счётчик периода, если его ещё нет, и возвращает строку. Снимок лимита берётся
 * **один раз при открытии** (`35` §7.3): смена тарифа в середине месяца не переписывает
 * задним числом уже потраченное. Роль `usage.counters_roll` (`35` §11) исполняется здесь же —
 * первое обращение в новом периоде открывает новую строку, прошлая остаётся историей.
 */
async function openCounter(tx: TenantTx, tenantId: string, axis: LimitAxis, w: BillingWindow, limit: number | null) {
  await tx.execute(sql`
    insert into usage_counters (tenant_id, axis, period_start, period_end, used, limit_snapshot)
    values (${tenantId}::uuid, ${axis}, ${w.start}::date, ${w.end}::date, 0, ${limit})
    on conflict (tenant_id, axis, period_start) do nothing
  `)
}

export interface UsageRef {
  refKind?: UsageRefKind
  refId?: string | null
  actorUserId?: string | null
  meta?: Record<string, unknown>
}

/**
 * Пополнить счётчик оси и (для измеряемых операций) записать строку журнала расхода.
 *
 * Вызывается **после** успеха операции: ИИ-вызов, упавший по вине провайдера, не пишет
 * `usage_events` и не двигает счётчик (`35` §12, критерий §13 к. 9). Отрицательная `delta`
 * освобождает место в той же транзакции (§7.5: блокировка сотрудника, архивация кандидата,
 * удаление файла, отключение интеграции).
 */
export async function recordUsage(tenantId: string, axis: LimitAxis, delta: number, ref: UsageRef = {}): Promise<number> {
  if (!delta) return currentUsage(tenantId, axis)
  const prep = await prepareUsage(tenantId, axis)
  const used = await withTenant(tenantId, ref.actorUserId ?? null, tx => applyUsageTx(tx, tenantId, axis, delta, ref, prep))
  await settleUsage(tenantId, axis, used, prep.limit)
  return used
}

/** Лимит и окно периода — читаются до транзакции (кеш `effectiveLimits`, PR-08). */
export interface UsagePrep { limit: number | null, window: BillingWindow }

export async function prepareUsage(tenantId: string, axis: LimitAxis): Promise<UsagePrep> {
  return { limit: await effectiveLimit(tenantId, axis), window: await currentWindow(tenantId) }
}

/**
 * Тело `recordUsage()` внутри **чужой** транзакции: счётчик и строка журнала расхода пишутся
 * атомарно с тем, за что списываются. Так шлюз модели (`server/services/ai/gateway.ts`, PR-27)
 * отмечает вызов успешным, списывает операцию и сохраняет результат одной транзакцией — тенант
 * не платит за результат, который не сохранился, и не получает результат без списания.
 * После фиксации транзакции вызывающий обязан позвать `settleUsage()` (баннер и уведомление).
 */
export async function applyUsageTx(tx: TenantTx, tenantId: string, axis: LimitAxis, delta: number, ref: UsageRef, prep: UsagePrep): Promise<number> {
  const w = prep.window
  const refKind = ref.refKind ?? AXIS_METER[axis].refKind
  await openCounter(tx, tenantId, axis, w, prep.limit)
  const [row] = await tx.execute(sql`
    update usage_counters
       set used = greatest(0, used + ${delta}), updated_at = now()
     where tenant_id = ${tenantId}::uuid and axis = ${axis} and period_start = ${w.start}::date
     returning used
  `) as unknown as { used: string | number }[]
  if (refKind) {
    await tx.insert(usageEvents).values({
      tenantId,
      axis,
      delta,
      refKind,
      refId: ref.refId ?? null,
      actorUserId: ref.actorUserId ?? null,
      meta: ref.meta ?? {},
      requestContext: currentRequestContext(), // null у фоновых задач — это норма
    })
  }
  return Number(row?.used ?? 0)
}

/** Поднять или погасить предупреждение оси после зафиксированного изменения счётчика. */
export async function settleUsage(tenantId: string, axis: LimitAxis, used: number, limit: number | null): Promise<void> {
  await noticeAfterChange(tenantId, axis, used, limit)
}

/**
 * Привести счётчик моментальной оси к факту (`35` §7.1: «моментально»). Именно эта функция
 * делает сквозную проверку 15 (`42` §5) содержательной: значение `usage_counters.used`
 * обязано совпадать с прямым пересчётом по определению оси.
 */
export async function syncCounter(tenantId: string, axis: LimitAxis, value: number): Promise<number> {
  const limit = await effectiveLimit(tenantId, axis)
  const w = await currentWindow(tenantId)
  await withTenant(tenantId, null, async (tx) => {
    await openCounter(tx, tenantId, axis, w, limit)
    await tx.execute(sql`
      update usage_counters set used = ${value}, updated_at = now()
       where tenant_id = ${tenantId}::uuid and axis = ${axis} and period_start = ${w.start}::date
    `)
  })
  await noticeAfterChange(tenantId, axis, value, limit)
  return value
}

/** Факт по моментальной оси — прямым пересчётом по определению `35` §7.1. */
export async function measureLive(tenantId: string, axis: LimitAxis): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const q = async (fragment: ReturnType<typeof sql>) => {
      const [r] = await tx.execute(fragment) as unknown as { n: string | number }[]
      return Number(r?.n ?? 0)
    }
    switch (axis) {
      case 'users_active':
        return q(sql`select count(*)::int as n from users where status = 'active' and not is_blocked ${EMPLOYEES_ONLY('')}`)
      case 'candidates_active':
        // До PR-13 колонки `candidate_state` не существовало, и «не в архиве» приходилось
        // выводить из `users.status` — приближение, которое считало отказанных. С появлением
        // оси воронки (docs/v2/28 §3.2) определение стало точным: в лимит идут только
        // `active`; `hired`, `rejected`, `archived` и `withdrawn` мест не занимают
        // (`35` §7.1, `28` §7.1, §15 Г-28.7 — тенант не должен платить за архив).
        return q(sql`select count(*)::int as n from users where candidate_state = 'active' ${CANDIDATES_ONLY('')}`)
      case 'storage_bytes':
        // Оперативный счётчик хранилища (docs/v2/34 §7.4 п. 1, PR-36): его ведёт триггер на
        // `media_assets`, по нему же проверяется загрузка — второго подсчёта суммой по файлам нет
        return q(sql`select coalesce(sum(bytes), 0)::bigint as n from storage_usage_counters`)
      case 'integrations_active':
        return q(sql`select count(*)::int as n from webhook_endpoints where is_active`)
      default:
        return 0
    }
  })
}

/** Текущее значение оси: моментальная — пересчётом, накопительная — из счётчика периода. */
export async function currentUsage(tenantId: string, axis: LimitAxis): Promise<number> {
  if (AXIS_METER[axis].source === 'live' && axis !== 'api_rate_rpm') return measureLive(tenantId, axis)
  const w = await currentWindow(tenantId)
  return withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.select({ used: usageCounters.used }).from(usageCounters)
      .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.axis, axis), eq(usageCounters.periodStart, w.start)))
    return r?.used ?? 0
  })
}

/** Пересчёт всех моментальных осей: `usage.collect`, `billing.limit_scan` и жёсткая проверка. */
export async function syncLiveAxes(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const axis of LIVE_AXES) out[axis] = await syncCounter(tenantId, axis, await measureLive(tenantId, axis))
  return out
}

// ── Проверка и деградация ───────────────────────────────────────────────────────────────

export interface AxisState extends LimitCheck {
  kind: AxisKind
  source: AxisSource
  /** Чем операция заменяется при исчерпании (`35` §7.1, столбец «При исчерпании»). */
  degradation: AxisDegradation | null
  pct: number | null
  periodStart: string
  periodEnd: string
}

/**
 * Состояние оси перед операцией: пройдёт ли она и, если нет, чем заменяется.
 *
 * Решение «пройдёт или нет» принимает `checkLimit()` из PR-08 — здесь только факт и перевод
 * столбца «При исчерпании» в машинное значение. Мягкая ось (`telegram_out`) всегда `ok`:
 * канал бесплатный, доставка не останавливается (`35` §7.1, `25` §10).
 */
export async function axisState(tenantId: string, axis: LimitAxis, delta = 1): Promise<AxisState> {
  const used = await currentUsage(tenantId, axis)
  const check = await checkLimit(tenantId, axis, used, delta)
  const w = await currentWindow(tenantId)
  const meter = AXIS_METER[axis]
  return {
    ...check,
    kind: meter.kind,
    source: meter.source,
    degradation: check.ok ? null : meter.onExhausted,
    pct: check.limit == null || check.limit <= 0 ? null : Math.round(used / check.limit * 100),
    periodStart: w.start,
    periodEnd: w.end,
  }
}

/**
 * Проверка оси в точке операции с деградацией вместо остановки (П-25.2, `35` §7.1, §7.4).
 *
 * Возвращает `{ allowed, degradation }`: `allowed = false` только у осей, которые документ
 * называет жёсткими **без** деградации, — там вызывающий бросает `LimitExceededError`
 * (единый `409 limit_exceeded` с `details.axis`, `35` §10). У осей «жёсткий с деградацией»
 * и мягких операция идёт дальше другим путём: `manual_review`, `background_job`,
 * `channel_fallback`, `observe`. Обучение не останавливается ни в одном случае.
 */
export async function meterOrDegrade(tenantId: string, axis: LimitAxis, delta = 1): Promise<{ allowed: boolean, degradation: AxisDegradation | null, state: AxisState }> {
  const state = await axisState(tenantId, axis, delta)
  if (state.ok) return { allowed: true, degradation: null, state }
  const meter = AXIS_METER[axis]
  const allowed = meter.kind !== 'hard'
  return { allowed, degradation: meter.onExhausted, state }
}

// ── Сводка потребления для экрана и панели оператора ─────────────────────────────────────

export interface AxisUsage {
  axis: LimitAxis
  used: number
  limit: number | null
  pct: number | null
  kind: AxisKind
  source: AxisSource
  level: 'ok' | 'warn' | 'exceeded'
  degradation: AxisDegradation | null
  periodStart: string
  periodEnd: string
}

/** Порог предупреждения (`35` §7.9 п. 1; `platform_settings.limit_warn_pct` — см. docs/28). */
export const LIMIT_WARN_PCT = 0.8

/**
 * `[fix-night-debts §3]` Нулевой лимит — не «без обмежень» (`null`), а «вимкнено зовсім»: ось,
 * которую тенант не трогал (`used=0`), не должна мигать баннером вечно — только `ok`; но ось,
 * по которой была попытка (вызывающий на месте блокировки передаёт `used` уже с учётом попытки,
 * `server/services/ai/gateway.ts`), обязана дать `exceeded`, а не молчать. Прежняя строка
 * `limit <= 0 → 'ok'` глушила оба случая одинаково — баннер и `limit_exceeded` не поднимались
 * никогда, даже при реальном отказе вызова.
 */
export function levelOf(used: number, limit: number | null): 'ok' | 'warn' | 'exceeded' {
  if (limit == null) return 'ok'
  if (limit <= 0) return used > 0 ? 'exceeded' : 'ok'
  if (used >= limit) return 'exceeded'
  return used / limit >= LIMIT_WARN_PCT ? 'warn' : 'ok'
}

/**
 * Потребление по всем одиннадцати осям — одним проходом, одной формулой лимита.
 * То же число показывает баннер, экран потребления и панель оператора: расчёт один
 * (`35` §7.3, решение В-5) — расходиться нечему.
 */
export async function usageByAxis(tenantId: string): Promise<AxisUsage[]> {
  const limits = await effectiveLimits(tenantId)
  const w = billingWindow(limits.subscription)
  const counters = await withTenant(tenantId, null, tx => tx
    .select({ axis: usageCounters.axis, used: usageCounters.used })
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.periodStart, w.start))))
  const byAxis = new Map(counters.map(c => [c.axis, c.used]))
  const out: AxisUsage[] = []
  for (const axis of LIMIT_AXES) {
    const meter = AXIS_METER[axis]
    const used = meter.source === 'live' && axis !== 'api_rate_rpm'
      ? await measureLive(tenantId, axis)
      : byAxis.get(axis) ?? 0
    const limit = limits.axes[axis]
    const level = levelOf(used, limit)
    out.push({
      axis,
      used,
      limit,
      pct: limit == null || limit <= 0 ? null : Math.round(used / limit * 100),
      kind: meter.kind,
      source: meter.source,
      level,
      degradation: level === 'exceeded' ? meter.onExhausted : null,
      periodStart: w.start,
      periodEnd: w.end,
    })
  }
  return out
}

/** Сумма журнала расхода по оси за период — для сверки счётчика с агрегатом. */
export async function eventSum(tenantId: string, axis: LimitAxis, w?: BillingWindow): Promise<number> {
  const win = w ?? await currentWindow(tenantId)
  return withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.execute(sql`
      select coalesce(sum(delta), 0)::bigint as n from usage_events
       where tenant_id = ${tenantId}::uuid and axis = ${axis}
         and occurred_at >= ${win.start}::date and occurred_at < (${win.end}::date + 1)
    `) as unknown as { n: string | number }[]
    return Number(r?.n ?? 0)
  })
}

/** `usage.prune` (`35` §11): журнал расхода хранится 400 дней. */
export async function pruneUsageEvents(tenantId: string, days = 400): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      delete from usage_events where occurred_at < now() - ${`${days} days`}::interval returning id
    `) as unknown as unknown[]
    return rows.length
  })
}

/** Хранилище в гигабайтах — для подписей экрана (единица оси остаётся байтом, `35` §7.1). */
export const toGb = (bytes: number) => bytes / GIB

// Подъём и гашение предупреждений живёт в отдельном модуле; импорт отложенный, чтобы
// `limitNotices.ts` мог звать этот файл и не получить цикла на этапе загрузки.
async function noticeAfterChange(tenantId: string, axis: LimitAxis, used: number, limit: number | null): Promise<void> {
  const { syncNotice } = await import('./limitNotices')
  await syncNotice(tenantId, axis, used, limit)
}

/** Активные тенанты — общий помощник фоновых задач пакета. */
export async function activeTenantIdsForUsage(): Promise<string[]> {
  const rows = await db.execute(sql`select id from tenants where status = 'active'`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}
