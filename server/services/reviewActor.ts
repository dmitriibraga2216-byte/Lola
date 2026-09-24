import { can } from './access'
import type { Access } from './access'

/**
 * Кто действует в очереди проверки и в какой области. Сервисы делегирования, распределения и
 * нагрузки решают «можно ли» не по роли, а по скоупу в области точки работы (`docs/v2/37` §2:
 * «керівник ✓ своей области»): руководитель точки отзывает и переназначает только у себя.
 *
 * Отдельный тип, а не `Access` целиком: сервису нужны три вопроса, а тесту — возможность
 * собрать проверяющего с нужными правами без сессии.
 */
export interface ReviewActor {
  tenantId: string
  actorId: string
  /** Есть ли скоуп в области точки работы; без точки — в любой области. */
  can: (scope: string, locationId?: string | null) => boolean
  /** Скоуп выдан на весь тенант — нужен для правил распределения «на всю сеть». */
  tenantWide: (scope: string) => boolean
  /** Точки, на которые выдан скоуп ролью уровня точки. */
  locations: (scope: string) => string[]
}

export function reviewActorOf(access: Pick<Access, 'tenantId' | 'userId' | 'grants'>): ReviewActor {
  const a = access as Access
  return {
    tenantId: access.tenantId,
    actorId: access.userId,
    can: (scope, locationId) => can(a, scope, locationId ? { locationId } : undefined),
    tenantWide: scope => access.grants.some(g => g.scopes.includes(scope) && g.scopeType === 'tenant'),
    locations: scope => access.grants.filter(g => g.scopes.includes(scope) && g.scopeType === 'location' && g.scopeId).map(g => g.scopeId!),
  }
}
