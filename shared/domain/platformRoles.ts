import { PLATFORM_ROLES, type PlatformRole } from '../enums'

/**
 * Права операторов платформы (docs/25 §7 п. 7, решение владельца продукта 26.09.2026).
 *
 * Одна функция `platformCan(role, action)` — как `can()` у тенанта: её зовёт каждая ручка
 * `/api/v1/platform/*` (через `requirePlatform(event, action)`), а интерфейс консоли — только
 * чтобы спрятать кнопку. Сервер решает, клиент показывает (CLAUDE.md п. 3).
 *
 * | Роль | Что может |
 * | --- | --- |
 * | `owner` | всё, в том числе операторы (приглашение, роль, деактивация, сброс 2FA оператора) и окончательное удаление (`purge`) |
 * | `admin` | все действия с компаниями, кроме `purge` и операторов |
 * | `billing` | чтение + тариф, лимиты, платежи, продление, смена тарифа |
 * | `support` | чтение компаний и пользователей (без денег), вход «від імені», сброс 2FA пользователю компании |
 * | `viewer` | только чтение, включая тариф и платежи |
 */

export const PLATFORM_ACTIONS = [
  // Чтение
  'platform.read', // метрики, тарифная сетка, объявления, журнал платформы
  'tenant.read', // список компаний, карточка, этапы
  'tenant.users.read', // пользователи компании (агрегаты и список без содержимого)
  'billing.read', // лимиты, подписка, история платежей
  'operators.read', // список операторов
  // Компании
  'tenant.create',
  'tenant.update', // название, домен, settings, SMTP TLS, возможности этапов
  'tenant.suspend', // приостановка и возобновление
  'tenant.purge', // окончательное удаление и его отмена
  'tenant.impersonate',
  'tenant.two_factor_reset', // сброс второго фактора пользователю компании
  // Деньги
  'billing.limits',
  'billing.payments',
  'billing.plan_change',
  'billing.extend',
  // Платформа
  'announcements.manage',
  'operators.manage', // пригласить, сменить роль, деактивировать
  'operators.two_factor_reset', // сброс второго фактора другому оператору
] as const
export type PlatformAction = typeof PLATFORM_ACTIONS[number]

const READ: PlatformAction[] = ['platform.read', 'tenant.read', 'tenant.users.read', 'operators.read']
const BILLING: PlatformAction[] = ['billing.read', 'billing.limits', 'billing.payments', 'billing.plan_change', 'billing.extend']
const OWNER_ONLY: PlatformAction[] = ['tenant.purge', 'operators.manage', 'operators.two_factor_reset']

export const PLATFORM_MATRIX: Record<PlatformRole, ReadonlySet<PlatformAction>> = {
  owner: new Set(PLATFORM_ACTIONS),
  admin: new Set(PLATFORM_ACTIONS.filter(a => !OWNER_ONLY.includes(a))),
  billing: new Set([...READ, ...BILLING]),
  support: new Set([...READ, 'tenant.impersonate', 'tenant.two_factor_reset']),
  viewer: new Set([...READ, 'billing.read']),
}

export function isPlatformRole(v: unknown): v is PlatformRole {
  return typeof v === 'string' && (PLATFORM_ROLES as readonly string[]).includes(v)
}

/** Может ли оператор с этой ролью выполнить действие. Неизвестная роль — ничего. */
export function platformCan(role: string | null | undefined, action: PlatformAction): boolean {
  return isPlatformRole(role) && PLATFORM_MATRIX[role].has(action)
}
