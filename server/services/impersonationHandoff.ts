import { createHash } from 'node:crypto'
import { decrypt, encrypt } from './crypto'
import { isBlocked, setBlock } from './rateLimit'
import { hostConfig } from './tenantResolve'

/**
 * Передача входа «от имени» с хоста консоли на хост тенанта (docs/24 §4.5, docs/25 §7 п. 6).
 *
 * Консоль живёт на своём хосте (`OPS_HOST`), и cookie тенантской сессии, поставленная там, до
 * `<slug>.<base>` не доходит — она host-only. Поэтому консоль получает одноразовую ссылку на хост
 * тенанта: токен сессии внутри зашифрован ключом приложения (AES-256-GCM, `crypto.ts`), ссылка
 * живёт 60 секунд и принимается один раз. Хост тенанта сам ставит свою cookie (`/impersonate/go`).
 */

export const HANDOFF_TTL_SEC = 60
const USED_KEY = (h: string) => `imp:handoff:${createHash('sha256').update(h).digest('hex')}`

export function sealHandoff(sessionToken: string, now = Date.now()): string {
  const { ciphertext, nonce } = encrypt(JSON.stringify({ s: sessionToken, e: now + HANDOFF_TTL_SEC * 1000 }))
  return `${nonce.toString('base64url')}.${ciphertext.toString('base64url')}`
}

/** Токен сессии из ссылки или null: подделка, истёкшая или уже использованная ссылка. */
export async function openHandoff(h: string, now = Date.now()): Promise<string | null> {
  const [n, c] = h.split('.')
  if (!n || !c) return null
  let payload: { s?: unknown, e?: unknown }
  try { payload = JSON.parse(decrypt(Buffer.from(c, 'base64url'), Buffer.from(n, 'base64url'))) }
  catch { return null }
  if (typeof payload.s !== 'string' || typeof payload.e !== 'number' || payload.e < now) return null
  if (await isBlocked(USED_KEY(h))) return null
  await setBlock(USED_KEY(h), HANDOFF_TTL_SEC * 2)
  return payload.s
}

/** Хост тенанта для ссылки: собственный домен, иначе `<slug>.<TENANT_HOST_BASE>`, иначе хост по умолчанию. */
export function tenantHostFor(t: { slug: string, customDomain: string | null }): string | null {
  if (t.customDomain) return t.customDomain
  const cfg = hostConfig()
  if (cfg.base) return `${t.slug}.${cfg.base}`
  return cfg.defaultHosts[0] ?? null
}
