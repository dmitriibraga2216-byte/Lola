import { eq } from 'drizzle-orm'
import type { ModuleCode } from '../../shared/schemas/settings'
import { db } from '../db/client'
import { plans, tenants } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { readSettings } from './settings'

/**
 * Модули тенанта (docs/24 §3.2, Г-24.2, §12.4): выключенный модуль исчезает из меню и из API —
 * его маршруты отвечают 403 `module.disabled`; данные не удаляются, отчёты остаются администратору.
 * Проверка — в middleware `03.modules`, по префиксу пути. Настройки кешируются на минуту
 * на процесс; запись модулей сбрасывает кеш (`invalidateModules`).
 */

/** Маршруты API → модуль. Отчёты по модулю (`/reports/*`) в список не входят — docs/24 §7.2. */
export const MODULE_ROUTES: { prefix: string, module: ModuleCode }[] = [
  { prefix: '/api/v1/workshops', module: 'workshops' },
  { prefix: '/api/v1/programs', module: 'programs' },
  { prefix: '/api/v1/program-enrollments', module: 'programs' },
  { prefix: '/api/v1/trajectories', module: 'trajectories' },
  { prefix: '/api/v1/automation-rules', module: 'trajectories' },
  { prefix: '/api/v1/meetups', module: 'meetups' },
  { prefix: '/api/v1/complex-tests', module: 'complexTests' },
  { prefix: '/api/v1/complex-attempts', module: 'complexTests' },
  { prefix: '/api/v1/development', module: 'development' },
  { prefix: '/api/v1/competencies', module: 'development' },
  { prefix: '/api/v1/competency-categories', module: 'development' },
  { prefix: '/api/v1/competency-matrix', module: 'development' },
  { prefix: '/api/v1/position-profiles', module: 'development' },
  { prefix: '/api/v1/strategic-plans', module: 'development' },
  { prefix: '/api/v1/assessment', module: 'assessment' },
  { prefix: '/api/v1/checklists', module: 'assessment' },
  { prefix: '/api/v1/checklist-runs', module: 'assessment' },
  { prefix: '/api/v1/knowledge', module: 'knowledge' },
  { prefix: '/api/v1/news', module: 'news' },
  { prefix: '/api/v1/notices', module: 'notices' },
  { prefix: '/api/v1/simple-notices', module: 'notices' },
  { prefix: '/api/v1/events', module: 'events' },
  { prefix: '/api/v1/wiki', module: 'wiki' },
]

/** Страницы админки и кабинета → модуль (для меню и клиентского middleware). */
export const MODULE_PAGES: { prefix: string, module: ModuleCode }[] = [
  { prefix: '/admin/workshops', module: 'workshops' },
  { prefix: '/admin/review-workshops', module: 'workshops' },
  { prefix: '/admin/programs', module: 'programs' },
  { prefix: '/admin/trajectories', module: 'trajectories' },
  { prefix: '/admin/rules', module: 'trajectories' },
  { prefix: '/admin/meetups/complex', module: 'complexTests' },
  { prefix: '/admin/meetups', module: 'meetups' },
  { prefix: '/admin/development', module: 'development' },
  { prefix: '/admin/assessment', module: 'assessment' },
  { prefix: '/admin/checklists', module: 'assessment' },
  { prefix: '/admin/knowledge', module: 'knowledge' },
  { prefix: '/admin/news', module: 'news' },
  { prefix: '/admin/notices', module: 'notices' },
  { prefix: '/admin/simple-notices', module: 'notices' },
  { prefix: '/admin/events', module: 'events' },
  { prefix: '/learn/wiki', module: 'wiki' },
  { prefix: '/learn/events', module: 'events' },
]

export function moduleOfRoute(path: string): ModuleCode | null {
  const clean = path.split('?')[0]!
  const hit = MODULE_ROUTES.find(r => clean === r.prefix || clean.startsWith(`${r.prefix}/`))
  return hit?.module ?? null
}

export function moduleOfPage(path: string): ModuleCode | null {
  const clean = path.split('?')[0]!
  // Более длинные префиксы первыми: /admin/meetups/complex раньше /admin/meetups
  const hit = [...MODULE_PAGES].sort((a, b) => b.prefix.length - a.prefix.length).find(r => clean === r.prefix || clean.startsWith(`${r.prefix}/`))
  return hit?.module ?? null
}

const TTL_MS = 60_000
const cache = new Map<string, { at: number, modules: Record<ModuleCode, boolean> }>()

export async function tenantModules(tenantId: string): Promise<Record<ModuleCode, boolean>> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules
  const s = await withTenant(tenantId, null, tx => readSettings(tx, tenantId))
  cache.set(tenantId, { at: Date.now(), modules: s.modules })
  return s.modules
}

export function invalidateModules(tenantId: string): void {
  cache.delete(tenantId)
}

export async function isModuleEnabled(tenantId: string, module: ModuleCode): Promise<boolean> {
  return (await tenantModules(tenantId))[module]
}

// ── Замок модуля по тарифу (docs/24 §3.2, §4.4; докс/33 D-053) ──

const LOCK_TTL_MS = 60_000
interface PlanRow { code: string, name: string, modules: string[] | null, sort: number }
let plansCache: { at: number, rows: PlanRow[] } | null = null

async function allPlans(): Promise<PlanRow[]> {
  if (plansCache && Date.now() - plansCache.at < LOCK_TTL_MS) return plansCache.rows
  const rows = await db.select({ code: plans.code, name: plans.name, modules: plans.modules, sort: plans.sort }).from(plans).orderBy(plans.sort)
  plansCache = { at: Date.now(), rows }
  return rows
}

/** Сбрасывается панелью оператора при правке `plans` (сейчас правка идёт напрямую в БД — задел на будущий CRUD `/platform/plans`). */
export function invalidatePlans(): void {
  plansCache = null
}

/** `null` в `modules` — тариф без обмежень (усі модулі доступні). */
const planAllows = (p: PlanRow, module: ModuleCode) => p.modules === null || p.modules.includes(module)

/**
 * null — модуль доступний на поточному тарифі тенанта. Інакше — найдешевший (за `sort`) тариф,
 * що включає модуль, для підпису «Доступно на тарифі «…»»; немає жодного — теж null (не блокуємо
 * мовчки, якщо модуль ніде не перелічений — ознака помилки налаштування тарифів, не заборони).
 */
export async function moduleLock(tenantId: string, module: ModuleCode): Promise<{ planCode: string, planName: string } | null> {
  const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
  if (!t) return null
  const rows = await allPlans()
  const current = rows.find(p => p.code === t.plan)
  if (!current || planAllows(current, module)) return null
  const cheapest = rows.find(p => planAllows(p, module))
  return cheapest ? { planCode: cheapest.code, planName: cheapest.name } : null
}
