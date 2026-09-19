import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import type { H3Event } from 'h3'

const header = (event: H3Event, name: string): string | undefined => {
  const v = event.node.req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Технический контекст события (CLAUDE.md п. 14, docs/02 «Сквозные таблицы», docs/22 §13.4):
 * один и тот же jsonb пишется во все журналы — audit_log, security_log, sessions,
 * enrollment_events, notifications, import_jobs, goal_status_log, automation_runs.
 * Формат — ровно как в docs/02: {ip, geo: {country, country_code, city}, user_agent, browser, os, device}.
 *
 * Контекст кладётся middleware в AsyncLocalStorage, поэтому сервисы берут его через
 * currentRequestContext() без протаскивания event; в фоновых задачах он null.
 * Геолокация — из локальной базы MaxMind (GEOIP_DB_PATH, GeoLite2-City.mmdb); без базы geo = null.
 */
export interface RequestContext {
  ip: string | null
  geo: { country: string | null, country_code: string | null, city: string | null } | null
  user_agent: string | null
  browser: string | null
  os: string | null
  device: 'mobile' | 'tablet' | 'desktop' | 'bot' | null
}

const als = new AsyncLocalStorage<RequestContext>()
/** Доступ к текущему событию Nitro (experimental.asyncContext) — регистрируется middleware, в тестах отсутствует. */
let eventAccessor: (() => H3Event | undefined) | null = null

export function registerEventAccessor(fn: () => H3Event | undefined): void {
  eventAccessor = fn
}

export function currentRequestContext(): RequestContext | null {
  const fromAls = als.getStore()
  if (fromAls) return fromAls
  try {
    const ev = eventAccessor?.()
    return (ev?.context.requestContext as RequestContext | undefined) ?? null
  }
  catch {
    return null
  }
}

/** Выполнить fn с заданным контекстом (фоновые задачи, тесты). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn)
}

/** Браузер и ОС из user-agent: только имя и мажорная версия, как в журнале эталона («Chrome 144, Windows»). */
export function parseUserAgent(ua: string | null): Pick<RequestContext, 'browser' | 'os' | 'device'> {
  if (!ua) return { browser: null, os: null, device: null }
  const s = ua
  let browser: string | null = null
  const pick = (name: string, re: RegExp) => { const m = s.match(re); if (m && !browser) browser = `${name} ${m[1]!.split('.')[0]}` }
  pick('Edge', /Edg(?:e|A|iOS)?\/(\d+[\d.]*)/)
  pick('Opera', /OPR\/(\d+[\d.]*)/)
  pick('Samsung Internet', /SamsungBrowser\/(\d+[\d.]*)/)
  pick('Firefox', /Firefox\/(\d+[\d.]*)/)
  pick('Chrome', /(?:Chrome|CriOS)\/(\d+[\d.]*)/)
  if (!browser && /Safari\//.test(s)) { const m = s.match(/Version\/(\d+[\d.]*)/); browser = m ? `Safari ${m[1]!.split('.')[0]}` : 'Safari' }
  if (!browser && /Telegram/i.test(s)) browser = 'Telegram'
  if (!browser && /bot|crawl|spider|curl|wget|python-requests/i.test(s)) browser = 'Bot'

  let os: string | null = null
  if (/iPhone|iPad|iPod/.test(s)) { const m = s.match(/OS (\d+)[_.]/); os = m ? `iOS ${m[1]}` : 'iOS' }
  else if (/Android/.test(s)) { const m = s.match(/Android (\d+)/); os = m ? `Android ${m[1]}` : 'Android' }
  else if (/Windows/.test(s)) os = 'Windows'
  else if (/Mac OS X/.test(s)) os = 'macOS'
  else if (/CrOS/.test(s)) os = 'ChromeOS'
  else if (/Linux/.test(s)) os = 'Linux'

  const device: RequestContext['device'] = browser === 'Bot'
    ? 'bot'
    : /iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s)) ? 'tablet' : /Mobi|iPhone|Android/.test(s) ? 'mobile' : 'desktop'
  return { browser, os, device }
}

type GeoReader = { get: (ip: string) => { country?: { names?: Record<string, string>, iso_code?: string }, city?: { names?: Record<string, string> } } | null }
let geoReader: GeoReader | null | undefined

/** Читатель MaxMind открывается один раз; отсутствие базы — штатно (geo = null). */
async function geoOf(ip: string | null): Promise<RequestContext['geo']> {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return null
  if (geoReader === undefined) {
    const path = process.env.GEOIP_DB_PATH
    if (!path || !existsSync(path)) geoReader = null
    else {
      try {
        const mod = await import('maxmind')
        geoReader = await mod.open(path) as unknown as GeoReader
      }
      catch (err) {
        console.error('geoip: не удалось открыть базу', err)
        geoReader = null
      }
    }
  }
  if (!geoReader) return null
  try {
    const r = geoReader.get(ip)
    if (!r) return null
    return {
      country: r.country?.names?.uk ?? r.country?.names?.en ?? null,
      country_code: r.country?.iso_code ?? null,
      city: r.city?.names?.uk ?? r.city?.names?.en ?? null,
    }
  }
  catch {
    return null
  }
}

/** IP клиента за прокси (Cloudflare → cf-connecting-ip, иначе первый из x-forwarded-for). Дублирует authCookies.clientIp без Nitro-глобалов. */
function ipOf(event: H3Event): string | null {
  return header(event, 'cf-connecting-ip')
    || header(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || event.node.req.socket?.remoteAddress
    || null
}

export async function requestContextOf(event: H3Event): Promise<RequestContext> {
  const ip = ipOf(event)
  const userAgent = header(event, 'user-agent')?.slice(0, 300) ?? null
  return { ip, geo: await geoOf(ip), user_agent: userAgent, ...parseUserAgent(userAgent) }
}

/** Строка для журналов и интерфейса: «Chrome 144, Windows» / «Україна, Одеса». */
export function describeContext(ctx: RequestContext | null): { client: string | null, place: string | null } {
  if (!ctx) return { client: null, place: null }
  return {
    client: [ctx.browser, ctx.os].filter(Boolean).join(', ') || null,
    place: ctx.geo ? [ctx.geo.country, ctx.geo.city].filter(Boolean).join(', ') || null : null,
  }
}
