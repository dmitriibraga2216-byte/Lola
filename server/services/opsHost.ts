/**
 * Отдельный хост операторской консоли (docs/25 §7 п. 6, решение владельца 26.09.2026).
 *
 * `OPS_HOST` — хост консоли (прод: `ops.lmscappi.pp.ua`). Если задан:
 *  - на этом хосте открыты только операторский интерфейс (`/ops`, `/ops/*`), `/api/v1/platform/*`
 *    и служебное (сборка Nuxt, словари, health) — всё тенантское отвечает 404;
 *  - на любом другом хосте операторский интерфейс и `/api/v1/platform/*` отвечают 404;
 *  - cookie оператора — только на этом хосте (host-only, `SameSite=Strict`, `Secure`), а
 *    тенантская cookie на нём не читается.
 * Без `OPS_HOST` (dev, тесты) — как раньше: консоль по пути `/ops` на общем хосте.
 *
 * Проверка идёт раньше резолва тенанта по `Host` (`01.host`): иначе `ops.<TENANT_HOST_BASE>`
 * был бы принят за поддомен тенанта со slug `ops`.
 */

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '')

export function opsHostOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.OPS_HOST ? norm(env.OPS_HOST) : ''
  return v || null
}

/** Хост запроса без порта, в нижнем регистре. */
export function requestHost(host: string | undefined): string {
  return norm((host ?? '').split(':')[0] ?? '')
}

/** Путь операторской части: интерфейс консоли и её API. */
export function isOpsPath(path: string): boolean {
  const p = path.split('?')[0]!
  return p === '/ops' || p.startsWith('/ops/') || p === '/api/v1/platform' || p.startsWith('/api/v1/platform/')
}

/**
 * Служебное, что нужно странице консоли на её хосте: сборка и данные Nuxt, словари i18n,
 * PWA-файлы, пробы живости. Ничего тенантского.
 */
const OPS_HOST_SHARED = ['/_nuxt/', '/__nuxt', '/_i18n/', '/api/_', '/favicon', '/manifest.webmanifest', '/sw.js', '/health', '/ready']

export function isSharedPath(path: string): boolean {
  const p = path.split('?')[0]!
  return OPS_HOST_SHARED.some(s => p === s || p.startsWith(s) || p === s.replace(/\/$/, ''))
}

export type OpsHostDecision =
  | { kind: 'off' } // OPS_HOST не задан — всё как раньше
  | { kind: 'ops' } // операторский хост, путь разрешён
  | { kind: 'ops_root' } // операторский хост, корень — на список компаний
  | { kind: 'tenant' } // тенантский хост, путь не операторский
  | { kind: 'not_found' } // чужая половина: 404

/** Чистая функция: что делать с запросом при данной конфигурации. */
export function decideOpsHost(host: string | undefined, path: string, opsHost: string | null): OpsHostDecision {
  if (!opsHost) return { kind: 'off' }
  const onOps = requestHost(host) === opsHost
  const p = path.split('?')[0]!
  if (onOps) {
    if (p === '/' || p === '') return { kind: 'ops_root' }
    if (isOpsPath(p) || isSharedPath(p)) return { kind: 'ops' }
    return { kind: 'not_found' }
  }
  return isOpsPath(p) ? { kind: 'not_found' } : { kind: 'tenant' }
}

/** Куда ведёт корень консоли. */
export const OPS_HOME = '/ops/companies'
