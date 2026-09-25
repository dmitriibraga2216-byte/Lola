import { eq, sql } from 'drizzle-orm'
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
  // v2-allow: check1 — 'knowledge' тут код модуля «база знань», не код этапа lifecycle_stages
  { prefix: '/api/v1/knowledge', module: 'knowledge' },
  { prefix: '/api/v1/news', module: 'news' },
  { prefix: '/api/v1/notices', module: 'notices' },
  { prefix: '/api/v1/simple-notices', module: 'notices' },
  { prefix: '/api/v1/events', module: 'events' },
  { prefix: '/api/v1/wiki', module: 'wiki' },
  // Бонуси і магазин (docs/21 Г-21.1): витрина, заказы, журнал и ручные бонусы. Правила
  // нарахування (`/settings/rewards`) сюда не входят — баллы рейтинга начисляются и без магазина
  { prefix: '/api/v1/gift-store', module: 'bonuses' },
  { prefix: '/api/v1/bonuses', module: 'bonuses' },
  { prefix: '/api/v1/me/gift-store', module: 'bonuses' },
  { prefix: '/api/v1/me/bonuses', module: 'bonuses' },
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
  // v2-allow: check1 — 'knowledge' тут код модуля «база знань», не код этапа lifecycle_stages
  { prefix: '/admin/knowledge', module: 'knowledge' },
  { prefix: '/admin/news', module: 'news' },
  { prefix: '/admin/notices', module: 'notices' },
  { prefix: '/admin/simple-notices', module: 'notices' },
  { prefix: '/admin/events', module: 'events' },
  { prefix: '/learn/wiki', module: 'wiki' },
  { prefix: '/learn/events', module: 'events' },
  { prefix: '/admin/shop', module: 'bonuses' },
  { prefix: '/admin/bonuses', module: 'bonuses' },
  { prefix: '/learn/shop', module: 'bonuses' },
  { prefix: '/learn/bonuses', module: 'bonuses' },
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

// ── Рекрутинг: флаг тенанта, а не модуль настроек (docs/v2/28, миграция 0056) ──

/**
 * Рекрутинг включается **колонкой** `tenants.candidates_enabled`, а не ключом в
 * `settings.modules` (решение docs/v2/44 В-14, план docs/v2/45 PR-14): флаг заведён
 * миграцией 0056 до появления кандидатов и по нему же считается ось `candidates_active`.
 * Второй копии у него быть не должно, поэтому в перечень `MODULES` он не добавляется, а
 * маршруты гасятся здесь — той же механикой, что и выключенный модуль.
 *
 * Пути перечислены явно, без «всё, что начинается на /candidate»: публичный контур откликов
 * (PR-16) живёт под `/public/j/*` и флагом тенанта не гасится — он про приём отклика, а не
 * про работу с воронкой.
 */
export const RECRUITING_ROUTES = ['/api/v1/candidates', '/api/v1/candidate-statuses', '/api/v1/reports/recruiting-funnel', '/api/v1/interviews', '/api/v1/interview-scenarios', '/api/v1/candidate-summaries']

export function isRecruitingRoute(path: string): boolean {
  const clean = path.split('?')[0]!
  return RECRUITING_ROUTES.some(p => clean === p || clean.startsWith(`${p}/`))
}

const recruitingCache = new Map<string, { at: number, on: boolean }>()

/** Флаг тенанта с тем же кешем на минуту, что и модули; запись флага сбрасывает его. */
export async function isRecruitingEnabled(tenantId: string): Promise<boolean> {
  const hit = recruitingCache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on
  const [t] = await db.select({ on: tenants.candidatesEnabled }).from(tenants).where(eq(tenants.id, tenantId))
  const on = t?.on ?? false
  recruitingCache.set(tenantId, { at: Date.now(), on })
  return on
}

export function invalidateRecruiting(tenantId?: string): void {
  if (tenantId) recruitingCache.delete(tenantId)
  else recruitingCache.clear()
}

/** Тенанты с включённым рекрутингом — круг ночных задач воронки (docs/v2/28 §11). */
export async function recruitingTenantIds(): Promise<string[]> {
  const rows = await db.execute(sql`select id from tenants where status = 'active' and candidates_enabled order by created_at`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}
