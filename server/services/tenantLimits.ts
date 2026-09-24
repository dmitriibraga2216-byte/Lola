import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { planAddons, plans, tenantAddons, tenantLimits, tenants } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { LIMIT_AXES, type LimitAxis } from '../../shared/enums'
import { defaultDictionary } from './translations'

/**
 * Действующие лимиты тенанта — **одна функция эффективного лимита** на всю систему
 * (docs/v2/35-billing-limits.md §7.3, решение docs/v2/44 В-5, план docs/v2/45 PR-08):
 * число в баннере лимита, число в проверке при операции и число в расчёте счёта берутся
 * отсюда, а не считаются на месте сырым SQL. До PR-08 их считали в пяти местах отдельно
 * (`usage.ts` usageView, `platform.ts` listTenants/getTenantCard/checkPlanLimit,
 * `platformTenants.ts` getTenantLimits) — и число в панели оператора уже расходилось с
 * проверкой: `coalesce(tl.*, p.max_*)` не знал ни про доплаты, ни про умолчания.
 *
 * Формула (§7.3): `effective(axis) = coalesce(tenant_limits[axis], plans[axis])
 *                 + Σ(tenant_addons.qty × unit_step действующих на дату)`;
 * отсутствие значения в обеих колонках = «без обмежень» (`null`), и доплата к «без обмежень»
 * ничего не меняет. Одиннадцать осей — явными колонками (В-5); `jsonb` только у нетарифной
 * `telegram_out`, она живёт в `tenant_usage.axes` (PR-09) и лимита не имеет вовсе.
 *
 * `activeJobs` — квота задач на круг round-robin (docs/25 §5), ось вне пакета `35`,
 * по умолчанию DEFAULT_ACTIVE_JOBS. Кеш на процесс 60 с; панель оператора сбрасывает его
 * при записи (`invalidateLimits`), покупка и отключение доплаты — тоже.
 */

/** Колонки лимита в `tenant_limits`. Десять осей пакета плюс `activeJobs` (ось вне пакета). */
export const LIMIT_COLUMNS = [
  'users', 'storageGb', 'smsPerMonth', 'apiPerMinute', 'webhooks', 'activeJobs',
  'candidates', 'aiGenerateOps', 'aiReviewOps', 'aiInterviewOps', 'exportRows',
] as const
export type LimitColumn = typeof LIMIT_COLUMNS[number]

/**
 * Ось (`35` §7.1) → колонка лимита (В-5, таблица раскладки). `telegram_out` колонки не имеет:
 * канал бесплатный, ось мягкая — только наблюдение, лимита у неё нет ни в тарифе, ни у тенанта.
 */
export const AXIS_COLUMN: Record<LimitAxis, LimitColumn | null> = {
  users_active: 'users',
  candidates_active: 'candidates',
  storage_bytes: 'storageGb',
  ai_generate_ops: 'aiGenerateOps',
  ai_review_ops: 'aiReviewOps',
  ai_interview_ops: 'aiInterviewOps',
  sms_out: 'smsPerMonth',
  telegram_out: null,
  integrations_active: 'webhooks',
  api_rate_rpm: 'apiPerMinute',
  export_rows: 'exportRows',
}

/** Лимит тарифа по оси: колонка `plans.max_*`. Осей API и интеграций в тарифе нет (докс/33 D-055). */
const AXIS_PLAN_COLUMN: Partial<Record<LimitAxis, 'maxUsers' | 'maxCandidates' | 'maxStorageGb' | 'maxSmsPerMonth' | 'maxAiGenerateOps' | 'maxAiReviewOps' | 'maxAiInterviewOps' | 'maxExportRows'>> = {
  users_active: 'maxUsers',
  candidates_active: 'maxCandidates',
  storage_bytes: 'maxStorageGb',
  sms_out: 'maxSmsPerMonth',
  ai_generate_ops: 'maxAiGenerateOps',
  ai_review_ops: 'maxAiReviewOps',
  ai_interview_ops: 'maxAiInterviewOps',
  export_rows: 'maxExportRows',
}

/** Байт в гигабайте: `storage_bytes` считается в байтах, колонка лимита — в ГБ (В-5). */
export const GIB = 1024 * 1024 * 1024

export interface SubscriptionState {
  billingPeriod: 'month' | 'year'
  status: 'trial' | 'active' | 'grace' | 'readonly' | 'suspended'
  paidUntil: string | null
  graceUntil: string | null
  aiUntil: string | null
  autorenew: boolean
  currency: string
  aiStatus: 'active' | 'expired' | 'off'
}

export interface EffectiveLimits {
  users: number | null
  storageGb: number | null
  smsPerMonth: number | null
  apiPerMinute: number | null
  webhooks: number | null
  activeJobs: number
  candidates: number | null
  aiGenerateOps: number | null
  aiReviewOps: number | null
  aiInterviewOps: number | null
  exportRows: number | null
  /** Эффективный лимит по каждой из одиннадцати осей, **в единице оси** (§7.1). */
  axes: Record<LimitAxis, number | null>
  /** Доплаты, учтённые в `axes`, по осям — для строки «Додаткові опції» и расчёта счёта. */
  addons: Partial<Record<LimitAxis, number>>
  /** Колонки, где действует переопределение оператора, а не тариф. */
  overridden: LimitColumn[]
  subscription: SubscriptionState
}

export const DEFAULT_ACTIVE_JOBS = 100
/** Лимит Bearer-запросов без переопределения тенанта (докс/33 D-055) — прежняя константа `validateBearer`. */
export const DEFAULT_API_PER_MINUTE = 60

const TTL_MS = 60_000
const cache = new Map<string, { at: number, v: EffectiveLimits }>()

export function invalidateLimits(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId)
  else cache.clear()
}

/**
 * Σ(qty × unit_step) действующих на сегодня доплат, по осям (§7.3, §7.8 п. 1).
 * `unit_step` берётся со строки тенанта — это снимок на момент покупки, а не текущий каталог.
 * Ось читается из каталога; служебная `ai_term` (продление срока ИИ, §7.7 п. 6) осью лимита
 * не является и в сумму не попадает.
 */
async function addonsByAxis(tenantId: string): Promise<Partial<Record<LimitAxis, number>>> {
  const rows = await withTenant(tenantId, null, tx => tx
    .select({ axis: planAddons.axis, qty: tenantAddons.qty, unitStep: tenantAddons.unitStep })
    .from(tenantAddons)
    .innerJoin(planAddons, eq(planAddons.code, tenantAddons.addonCode))
    .where(and(
      sql`${tenantAddons.validFrom} <= current_date`,
      or(isNull(tenantAddons.validUntil), sql`${tenantAddons.validUntil} >= current_date`),
    )))
  const out: Partial<Record<LimitAxis, number>> = {}
  for (const r of rows) {
    if (!(LIMIT_AXES as readonly string[]).includes(r.axis)) continue // ai_term — срок, а не ось
    const axis = r.axis as LimitAxis
    out[axis] = (out[axis] ?? 0) + r.qty * Number(r.unitStep)
  }
  return out
}

export async function effectiveLimits(tenantId: string): Promise<EffectiveLimits> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
  const [o] = await withTenant(tenantId, null, tx => tx.select().from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId)))
  const addons = await addonsByAxis(tenantId)

  // Один проход по осям — одна формула. Ниже из `axes` раскладываются поля колонок, чтобы
  // прежние потребители (media, channels, webhooks, apiTokens, tenantQueue) не менялись.
  const axes = {} as Record<LimitAxis, number | null>
  for (const axis of LIMIT_AXES) {
    const col = AXIS_COLUMN[axis]
    const planCol = AXIS_PLAN_COLUMN[axis]
    const override = col ? o?.[col] ?? null : null
    const fromPlan = planCol ? p?.[planCol] ?? null : null
    let base = override ?? fromPlan
    // Единица оси — байты, единица колонки — ГБ (В-5): переводим перед сложением с доплатой,
    // чтобы «+100 ГБ» и лимит тарифа складывались в одной шкале, а не в двух.
    if (base != null && axis === 'storage_bytes') base *= GIB
    axes[axis] = base == null ? null : base + (addons[axis] ?? 0)
  }

  const overridden = LIMIT_COLUMNS.filter(k => o?.[k] != null)
  const v: EffectiveLimits = {
    users: axes.users_active,
    storageGb: axes.storage_bytes == null ? null : axes.storage_bytes / GIB,
    smsPerMonth: axes.sms_out,
    apiPerMinute: axes.api_rate_rpm,
    webhooks: axes.integrations_active,
    activeJobs: o?.activeJobs ?? DEFAULT_ACTIVE_JOBS,
    candidates: axes.candidates_active,
    aiGenerateOps: axes.ai_generate_ops,
    aiReviewOps: axes.ai_review_ops,
    aiInterviewOps: axes.ai_interview_ops,
    exportRows: axes.export_rows,
    axes,
    addons,
    overridden,
    subscription: {
      billingPeriod: (o?.billingPeriod ?? 'month') as SubscriptionState['billingPeriod'],
      status: (o?.status ?? 'trial') as SubscriptionState['status'],
      paidUntil: o?.paidUntil ?? null,
      graceUntil: o?.graceUntil ?? null,
      aiUntil: o?.aiUntil ?? null,
      autorenew: o?.autorenew ?? true,
      currency: o?.currency ?? 'EUR',
      aiStatus: (o?.aiStatus ?? 'active') as SubscriptionState['aiStatus'],
    },
  }
  cache.set(tenantId, { at: Date.now(), v })
  return v
}

/** Эффективный лимит одной оси в её единице (§7.1); `null` — «без обмежень». */
export async function effectiveLimit(tenantId: string, axis: LimitAxis): Promise<number | null> {
  return (await effectiveLimits(tenantId)).axes[axis]
}

/** Лимит тарифа по оси, без переопределения и доплат — для строки «ліміт тарифу» на экранах. */
export function planLimitOf(plan: typeof plans.$inferSelect | undefined, axis: LimitAxis): number | null {
  const planCol = AXIS_PLAN_COLUMN[axis]
  const value = planCol ? plan?.[planCol] ?? null : null
  return value != null && axis === 'storage_bytes' ? value * GIB : value
}

export interface LimitCheck {
  ok: boolean
  axis: LimitAxis
  used: number
  limit: number | null
  /** Допуск сверх лимита, учтённый в `ok` (только при `withGrace`, только у хранилища). */
  grace?: number
}

/**
 * Допуск сверх лимита хранилища для уже начатых загрузок (docs/v2/34 §7.5 `[решение]`):
 * **2 % лимита или 1 ГБ — что меньше**. Буфер нужен, чтобы начатая загрузка досылалась, а не
 * рвалась на последнем мегабайте. Живёт здесь, рядом с формулой лимита, а не в сервисе
 * хранилища: «лимит + допуск» — это тоже лимит, и второй его формулы в продукте быть не должно
 * (docs/v2/45 PR-36, условие выхода). У остальных осей допуска нет.
 */
export const STORAGE_GRACE_PCT = 0.02

export function graceOf(axis: LimitAxis, limit: number | null): number {
  if (limit == null || axis !== 'storage_bytes') return 0
  return Math.min(Math.floor(limit * STORAGE_GRACE_PCT), GIB)
}

/**
 * Проверка оси в момент операции (§7.5): потребление плюс шаг против эффективного лимита.
 * `delta = 0` — проверка «уже превышено» (баннер), `delta = 1` — «пройдёт ли следующая
 * операция». Мягкие оси (`telegram_out`) лимита не имеют и всегда `ok` — правило `25` §10
 * «обучение не останавливается лимитами» сильнее любого счётчика.
 *
 * `withGrace` — жёсткий порог загрузки файла `used + declared > limit + grace` (`34` §7.5):
 * так проверяет только выдача presigned URL. Баннер и счёт считают без допуска.
 */
export async function checkLimit(tenantId: string, axis: LimitAxis, used: number, delta = 1, opts: { withGrace?: boolean } = {}): Promise<LimitCheck> {
  const limit = await effectiveLimit(tenantId, axis)
  const grace = opts.withGrace ? graceOf(axis, limit) : 0
  return { ok: limit == null || used + delta <= limit + grace, axis, used, limit, ...(opts.withGrace ? { grace } : {}) }
}

/**
 * Единый отказ по жёсткому лимиту (`35` §10): в **любом** эндпоинте системы один и тот же
 * `409 limit_exceeded` с `details.axis`, чтобы фронт показывал один диалог везде.
 * Подпись оси и последствие — из словаря (`billing.axis.*`, `billing.limitConsequence.*`),
 * а не строкой в коде: CLAUDE.md п. 8.
 */
export class LimitExceededError extends Error {
  readonly statusCode = 409
  readonly code = 'limit_exceeded'
  readonly details: { axis: LimitAxis, used: number, limit: number | null }
  constructor(check: LimitCheck, locale: 'uk' | 'en' | 'ru' = 'uk') {
    super(limitMessage(check, locale))
    this.name = 'LimitExceededError'
    this.details = { axis: check.axis, used: check.used, limit: check.limit }
  }
}

/** «Ліміт вичерпано: {ось} — {використано} із {ліміт}. {наслідок}» (§5.5, §8). */
export function limitMessage(check: LimitCheck, locale: 'uk' | 'en' | 'ru' = 'uk'): string {
  const dict = defaultDictionary(locale)
  const label = dict[`billing.axis.${check.axis}`] ?? check.axis
  const consequence = dict[`billing.limitConsequence.${check.axis}`] ?? ''
  const head = (dict['billing.limitExceeded'] ?? '{axis} — {used} / {limit}')
    .replace('{axis}', label)
    .replace('{used}', String(check.used))
    .replace('{limit}', check.limit == null ? '∞' : String(check.limit))
  return consequence ? `${head} ${consequence}` : head
}

/** Проверить и упасть понятной ошибкой, если ось исчерпана (§7.4: список блокируемых операций). */
export async function assertWithinLimit(tenantId: string, axis: LimitAxis, used: number, delta = 1): Promise<void> {
  const check = await checkLimit(tenantId, axis, used, delta)
  if (!check.ok) throw new LimitExceededError(check)
}
