import type { PgBoss } from 'pg-boss'
import { getBoss } from './queue'
import { activeTenantIds, isTenantActive } from './tenantResolve'
import { effectiveLimits } from './tenantLimits'

/**
 * Изоляция фоновых задач (docs/25 §5, §14 п. 7, 8, 10):
 * - каждая задача несёт `tenantId` в payload (`enqueueForTenant`) и выполняется обработчиком в `withTenant`;
 * - планировщик раскладывает работу по тенантам (`runPerTenant`): круг round-robin начинается с тенанта,
 *   следующего за обслуженным в прошлый раз, падение одного тенанта не трогает остальных;
 * - квота на круг — `tenant_limits.active_jobs` (docs/25 §10): один тенант с 5000 уведомлений не задерживает
 *   остальных, потому что за круг он получает не больше квоты, а следующий круг снова начинается с соседа;
 * - приостановленный тенант (docs/25 §8) пропускается: задачи по нему не идут, данные целы.
 */

export interface TenantJobData { tenantId: string }

export interface RoundStats {
  order: string[]
  done: number
  skipped: number
  failed: number
  errors: Record<string, string>
}

const cursors = new Map<string, string | null>()
const running = new Map<string, number>()

/** Сброс курсоров и счётчиков (тесты). */
export function resetRoundRobin(): void {
  cursors.clear()
  running.clear()
}

/**
 * Порядок обхода: тот же список, повёрнутый так, чтобы первым шёл тенант после обслуженного последним.
 * Список на входе — отсортирован по id, иначе «следующий» не определён.
 */
export function roundRobinOrder(queue: string, tenantIds: string[]): string[] {
  if (tenantIds.length === 0) return []
  const last = cursors.get(queue) ?? null
  let start = 0
  if (last) {
    const idx = tenantIds.indexOf(last)
    if (idx >= 0) start = (idx + 1) % tenantIds.length
    else {
      // Обслуженный в прошлый раз сейчас без работы: начинаем с первого, кто «после него» по исходному порядку
      const after = tenantIds.findIndex(id => id > last)
      start = after >= 0 ? after : 0
    }
  }
  const order = [...tenantIds.slice(start), ...tenantIds.slice(0, start)]
  cursors.set(queue, order[order.length - 1]!)
  return order
}

// ── Лимит активных задач тенанта (docs/25 §10) ───────────────────────

/** Сколько задач тенанта выполняется сейчас в этом процессе. */
export function activeJobsOf(tenantId: string): number {
  return running.get(tenantId) ?? 0
}

/**
 * Слот тенанта: пока занято не меньше `active_jobs`, задача ждёт (poll 50 мс) — а не падает и не уходит
 * в retry, иначе pg-boss тратил бы retryLimit на «занято».
 */
export async function withTenantSlot<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const limit = (await effectiveLimits(tenantId)).activeJobs
  while ((running.get(tenantId) ?? 0) >= limit) await new Promise(r => setTimeout(r, 50))
  running.set(tenantId, (running.get(tenantId) ?? 0) + 1)
  try {
    return await fn()
  }
  finally {
    running.set(tenantId, Math.max(0, (running.get(tenantId) ?? 1) - 1))
  }
}

/**
 * Один круг планировщика по тенантам. `fn` получает квоту тенанта на круг (active_jobs) и обязан
 * работать внутри `withTenant`. Исключение одного тенанта — в `errors`, круг продолжается (docs/25 §14 п. 7).
 * Тенант не `active` — пропуск без вызова (п. 10). Без `source` — все работающие тенанты.
 */
export async function runPerTenant(
  queue: string,
  fn: (tenantId: string, quota: number) => Promise<unknown>,
  source?: string[] | (() => Promise<string[]>),
): Promise<RoundStats> {
  // Стабильный порядок (по id): «следующий за обслуженным» определён одинаково от круга к кругу
  const ids = [...(typeof source === 'function' ? await source() : source ?? await activeTenantIds())].sort()
  const stats: RoundStats = { order: roundRobinOrder(queue, ids), done: 0, skipped: 0, failed: 0, errors: {} }
  for (const tenantId of stats.order) {
    if (!(await isTenantActive(tenantId))) { stats.skipped++; continue }
    try {
      const quota = (await effectiveLimits(tenantId)).activeJobs
      await withTenantSlot(tenantId, () => fn(tenantId, quota))
      stats.done++
    }
    catch (err) {
      stats.failed++
      stats.errors[tenantId] = err instanceof Error ? err.message : String(err)
      console.error(`[${queue}] ${tenantId}:`, err)
    }
  }
  return stats
}

// ── Задачи с tenantId в payload ───────────────────────────────────────

export interface EnqueueOptions { singletonKey?: string, startAfter?: Date | number, priority?: number }

/** Единственный способ поставить задачу по тенанту: `tenantId` всегда в payload. Возвращает id задачи pg-boss. */
export async function enqueueForTenant<T extends object>(queue: string, tenantId: string, data: T, opts: EnqueueOptions = {}): Promise<string | null> {
  const b = await getBoss()
  return b.send(queue, { tenantId, ...data }, opts)
}

/**
 * Обработчик задачи по тенанту: статус (suspended → пропуск, п. 10), слот лимита, затем `handler` —
 * тот обязан открыть `withTenant(data.tenantId, …)`. Исключение уходит в pg-boss как обычно (retry по очереди).
 */
export function tenantJobHandler<T extends TenantJobData>(queue: string, handler: (data: T) => Promise<unknown>) {
  return async (data: T): Promise<{ skipped?: string } | unknown> => {
    if (!data?.tenantId) throw new Error(`[${queue}] задача без tenantId`)
    if (!(await isTenantActive(data.tenantId))) {
      console.log(`[${queue}] ${data.tenantId}: тенант не активний — пропуск`)
      return { skipped: 'tenant_inactive' }
    }
    return withTenantSlot(data.tenantId, () => handler(data))
  }
}

/** Регистрация обработчика задач по тенанту в pg-boss. Пакет по одной задаче: падение одной не роняет соседей. */
export async function workByTenant<T extends TenantJobData>(boss: PgBoss, queue: string, handler: (data: T) => Promise<unknown>, wrap: (fn: () => Promise<unknown>) => Promise<unknown> = fn => fn()): Promise<void> {
  const run = tenantJobHandler(queue, handler)
  await boss.work<T>(queue, async (jobs) => {
    for (const j of jobs as { data: T }[]) await wrap(() => run(j.data))
  })
}
