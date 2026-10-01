import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * Защита исходящих запросов на адреса, которые вписывает тенант (вебхуки, профили модели) — SSRF
 * (security-sweep-3). Сервер ходит туда сам и (у вебхуков) показывает тенанту ответ: без проверки
 * форма настроек становилась бы сканером внутренней сети — метаданные облака, `postgres`, `minio`.
 *
 * - адреса внутренних диапазонов (loopback, частные, link-local, CGNAT, ULA, IPv4 в IPv6) запрещены;
 * - имя без точки (`postgres`, `minio` — имена сервисов docker) запрещено;
 * - имя проверяется **в момент соединения** (`lookup` сокета), а не заранее: DNS с коротким TTL не
 *   подменит адрес между проверкой и запросом;
 * - редиректы не выполняются: ответ 3xx — это ответ.
 */

const blocked = new net.BlockList()
for (const [net4, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(net4, prefix, 'ipv4')
}
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) {
  blocked.addSubnet(net6, prefix, 'ipv6')
}

let allowPrivate = false
/** Тесты поднимают приёмник на 127.0.0.1 — только им можно снять запрет. */
export function setNetGuardAllowPrivate(v: boolean): void {
  allowPrivate = v
}

export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip)
  if (kind === 4) return blocked.check(ip, 'ipv4')
  if (kind === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return blocked.check(mapped[1]!, 'ipv4')
    const hex = ip.toLowerCase().match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const n = (Number.parseInt(hex[1]!, 16) << 16 >>> 0) + Number.parseInt(hex[2]!, 16)
      return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4')
    }
    return blocked.check(ip, 'ipv6')
  }
  return true
}

export type UrlCheck = 'ok' | 'invalid' | 'private'

/** Синтаксис и хост без DNS: схема, учётные данные в URL, IP-литерал, имя без точки. */
export function checkUrlShape(raw: string, opts: { httpsOnly?: boolean } = {}): UrlCheck {
  let u: URL
  try { u = new URL(raw) }
  catch { return 'invalid' }
  if (u.protocol !== 'https:' && ((opts.httpsOnly && !allowPrivate) || u.protocol !== 'http:')) return 'invalid'
  if (u.username || u.password) return 'invalid'
  if (allowPrivate) return 'ok'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return isPrivateAddress(host) ? 'private' : 'ok'
  if (!host.includes('.') || /(^|\.)(localhost|local|internal)$/i.test(host)) return 'private'
  return 'ok'
}

/** То же плюс DNS: все адреса имени должны быть публичными (проверка при сохранении настроек; не резолвится — решит соединение). */
export async function checkPublicUrl(raw: string, opts: { httpsOnly?: boolean } = {}): Promise<UrlCheck> {
  const shape = checkUrlShape(raw, opts)
  if (shape !== 'ok' || allowPrivate) return shape
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return 'ok'
  try {
    const addrs = await dns.promises.lookup(host, { all: true })
    return addrs.every(a => !isPrivateAddress(a.address)) ? 'ok' : 'private'
  }
  // Имя пока не резолвится (DNS ещё не настроен, временный сбой) — сохранить можно: доставку всё равно
  // проверяет `lookup` сокета в момент соединения
  catch { return 'ok' }
}

export class PrivateDestinationError extends Error {
  constructor() { super('destination_not_allowed') }
}

/** `lookup` сокета: те же адреса, что получит соединение, — без окна между проверкой и запросом. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0)
    const list = addresses as dns.LookupAddress[]
    if (!allowPrivate && (!list.length || list.some(a => isPrivateAddress(a.address)))) {
      return (callback as (e: Error | null, a: string, f: number) => void)(new PrivateDestinationError(), '', 0)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    return (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family)
  })
}

/**
 * POST JSON на внешний адрес с проверкой назначения при соединении. Без редиректов; тело ответа —
 * не больше `maxBody` байт.
 */
export function postExternal(raw: string, headers: Record<string, string>, body: string, opts: { timeoutMs?: number, maxBody?: number } = {}): Promise<{ status: number, text: string }> {
  const shape = checkUrlShape(raw)
  if (shape !== 'ok') return Promise.reject(shape === 'private' ? new PrivateDestinationError() : new Error('invalid_url'))
  const u = new URL(raw)
  const mod = u.protocol === 'https:' ? https : http
  const maxBody = opts.maxBody ?? 64_000
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: guardedLookup,
      timeout: opts.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size <= maxBody) chunks.push(c)
        else res.destroy()
      })
      const done = () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') })
      res.on('end', done)
      res.on('close', done)
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })))
    req.on('error', reject)
    req.end(body)
  })
}
