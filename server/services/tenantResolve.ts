import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { tenants, type TenantStatus } from '../db/schema'

/**
 * Резолв тенанта по `Host` (docs/25 §16.1, docs/27 §27.3) и статус тенанта для guard-ов (docs/25 §8, §14 п. 10).
 *
 * `TENANT_HOST_BASE` — базовый домен: `<slug>.<base>` → тенант; неизвестный поддомен — 404, чтобы перебором
 * нельзя было узнать список клиентов. `TENANT_HOST_DEFAULT` — хост (или список через запятую), который не является
 * slug-поддоменом, но обслуживает тенант по умолчанию `NUXT_PUBLIC_DEFAULT_TENANT` (стенд `lms.lmscappi.pp.ua`).
 * Хосты вне базы (localhost, IP, docker-имя, сам базовый домен) → тенант по умолчанию. Без `TENANT_HOST_BASE`
 * резолв выключен: тенант только из сессии (dev, тесты).
 *
 * Таблица `tenants` — платформенная, без RLS, читается только по id/slug (docs/25 §3.1).
 */

export interface ResolvedTenant { id: string, slug: string, status: TenantStatus, name: string }

/** 403 `tenant_suspended` (docs/25 §8, §14 п. 10): обработчик ошибок Nitro берёт statusCode и data как у createError. */
export class TenantClosedError extends Error {
  statusCode = 403
  data = { code: 'tenant_suspended', message: 'Простір призупинено оператором платформи. Зверніться до підтримки Lola' }
  constructor() { super('tenant_suspended') }
}

const TTL_MS = 10_000
const bySlug = new Map<string, { at: number, t: ResolvedTenant | null }>()
const byId = new Map<string, { at: number, t: ResolvedTenant | null }>()
const byDomain = new Map<string, { at: number, t: ResolvedTenant | null }>()

const fresh = <T>(hit: { at: number, t: T } | undefined): hit is { at: number, t: T } => !!hit && Date.now() - hit.at < TTL_MS

function remember(t: ResolvedTenant | null, slug?: string, id?: string, domain?: string) {
  const at = Date.now()
  if (t) { bySlug.set(t.slug, { at, t }); byId.set(t.id, { at, t }); if (domain) byDomain.set(domain, { at, t }) }
  else {
    if (slug) bySlug.set(slug, { at, t: null })
    if (id) byId.set(id, { at, t: null })
    if (domain) byDomain.set(domain, { at, t: null })
  }
  return t
}

/** Сбрасывается панелью оператора после suspend/resume/purge — статус виден приложению без ожидания TTL. */
export function invalidateTenant(id?: string): void {
  if (!id) { bySlug.clear(); byId.clear(); byDomain.clear(); return }
  const hit = byId.get(id)
  byId.delete(id)
  if (hit?.t) { bySlug.delete(hit.t.slug); byDomain.clear() } // домен не индексирован по id — проще сбросить весь кеш
}

export async function tenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  const hit = bySlug.get(slug)
  if (fresh(hit)) return hit.t
  const [row] = await db.select({ id: tenants.id, slug: tenants.slug, status: tenants.status, name: tenants.name }).from(tenants).where(eq(tenants.slug, slug))
  return remember(row ? { ...row, status: row.status as TenantStatus } : null, slug)
}

export async function tenantById(id: string): Promise<ResolvedTenant | null> {
  const hit = byId.get(id)
  if (fresh(hit)) return hit.t
  const [row] = await db.select({ id: tenants.id, slug: tenants.slug, status: tenants.status, name: tenants.name }).from(tenants).where(eq(tenants.id, id))
  return remember(row ? { ...row, status: row.status as TenantStatus } : null, undefined, id)
}

/** Тенант по собственному домену клиента (docs/25 §16.1, докс/33 D-059). */
export async function tenantByCustomDomain(domain: string): Promise<ResolvedTenant | null> {
  const hit = byDomain.get(domain)
  if (fresh(hit)) return hit.t
  const [row] = await db.select({ id: tenants.id, slug: tenants.slug, status: tenants.status, name: tenants.name }).from(tenants).where(eq(tenants.customDomain, domain))
  return remember(row ? { ...row, status: row.status as TenantStatus } : null, undefined, undefined, domain)
}

/** Тенант работает: вход, API и фоновые задачи разрешены (docs/25 §8 «Работа»). */
export async function isTenantActive(id: string): Promise<boolean> {
  return (await tenantById(id))?.status === 'active'
}

/** Все работающие тенанты — для планировщиков по тенантам (docs/25 §5). */
export async function activeTenantIds(): Promise<string[]> {
  const rows = await db.execute(sql`select id from tenants where status = 'active' order by created_at`) as unknown as { id: string }[]
  return rows.map(r => r.id)
}

// ── Host ───────────────────────────────────────────────────────────────

export interface HostConfig { base: string | null, defaultHosts: string[], defaultSlug: string | null }

export function hostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '')
  const base = env.TENANT_HOST_BASE ? norm(env.TENANT_HOST_BASE) : null
  const defaultHosts = (env.TENANT_HOST_DEFAULT ?? '').split(',').map(norm).filter(Boolean)
  const defaultSlug = env.NUXT_PUBLIC_DEFAULT_TENANT?.trim() || null
  return { base, defaultHosts, defaultSlug }
}

export type HostDecision = { kind: 'slug', slug: string } | { kind: 'default' } | { kind: 'off' }

/** Чистая функция: что означает Host при данной конфигурации. */
export function decideHost(host: string | undefined, cfg: HostConfig): HostDecision {
  if (!cfg.base) return { kind: 'off' }
  const h = (host ?? '').split(':')[0]!.toLowerCase().replace(/\.$/, '')
  if (!h || h === cfg.base || cfg.defaultHosts.includes(h)) return { kind: 'default' }
  if (!h.endsWith(`.${cfg.base}`)) return { kind: 'default' } // localhost, IP, docker-имя, чужой домен → как dev
  const sub = h.slice(0, -(cfg.base.length + 1))
  return { kind: 'slug', slug: sub }
}

/**
 * Тенант по Host: `null` — резолв выключен (тенант из сессии); `{tenant: null}` — 404 (неизвестный поддомен
 * или тенант по умолчанию не найден). Запись в `event.context` делает middleware `01.host`.
 *
 * Собственный домен клиента (docs/25 §16.1, докс/33 D-059): сначала `<slug>.<base>` (через
 * `decideHost`), затем — для любого хоста, который под эту схему не подпадает (localhost, IP,
 * докер-имя, базовый домен, `TENANT_HOST_DEFAULT`, реальный внешний домен) — точное совпадение
 * с `tenants.custom_domain`; не найден — обычный фолбек на тенант по умолчанию.
 */
export async function resolveTenantByHost(host: string | undefined, cfg: HostConfig = hostConfig()): Promise<{ tenant: ResolvedTenant | null } | null> {
  const d = decideHost(host, cfg)
  if (d.kind === 'off') return null
  if (d.kind === 'default') {
    const h = (host ?? '').split(':')[0]!.toLowerCase().replace(/\.$/, '')
    const byCustomDomain = h ? await tenantByCustomDomain(h) : null
    if (byCustomDomain) return { tenant: byCustomDomain }
    return { tenant: cfg.defaultSlug ? await tenantBySlug(cfg.defaultSlug) : null }
  }
  if (!/^[a-z0-9-]{3,40}$/.test(d.slug)) return { tenant: null }
  return { tenant: await tenantBySlug(d.slug) }
}
