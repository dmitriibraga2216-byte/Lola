import type { ModuleCode } from '../../shared/schemas/settings'
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
