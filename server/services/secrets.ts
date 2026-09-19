import { and, eq, sql } from 'drizzle-orm'
import { tenantSecrets } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { decrypt, encrypt } from './crypto'

interface Ctx { tenantId: string, actorId: string }

/**
 * Имена ключей — константы в одном модуле (docs/09 §9.2: «регистр и имя ключа
 * проверяются тестом»). Round-trip: записали → прочитали → совпало.
 */
export const SECRET_KEYS = {
  telegram: { BOT_TOKEN: 'bot_token', BOT_USERNAME: 'bot_username' },
  sms: { API_KEY: 'api_key', SENDER: 'sender', PROVIDER: 'provider' },
  smtp: { URL: 'url', FROM: 'from' },
  s3: { ACCESS_KEY: 'access_key', SECRET_KEY: 'secret_key', ENDPOINT: 'endpoint', BUCKET: 'bucket' },
  // OAuth-провайдеры (docs/09 §9.2): храним только refresh_token, access_token запрашиваем каждый раз
  google: { REFRESH_TOKEN: 'refresh_token', ACCOUNT_EMAIL: 'account_email', CALENDAR_ID: 'calendar_id' },
  zoom: { REFRESH_TOKEN: 'refresh_token', ACCOUNT_EMAIL: 'account_email' },
} as const

export type Provider = keyof typeof SECRET_KEYS

export async function setSecret(ctx: Ctx, provider: Provider, key: string, value: string, accountLabel?: string) {
  const { ciphertext, nonce } = encrypt(value)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.insert(tenantSecrets).values({
      tenantId: ctx.tenantId, provider, key, valueEncrypted: ciphertext, nonce, accountLabel: accountLabel ?? null, status: 'active', createdBy: ctx.actorId,
    }).onConflictDoUpdate({
      target: [tenantSecrets.tenantId, tenantSecrets.provider, tenantSecrets.key],
      set: { valueEncrypted: ciphertext, nonce, accountLabel: accountLabel ?? null, status: 'active', lastError: null, updatedAt: new Date() },
    })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'integration.secret_set', entity: 'tenant_secret', after: { provider, key } })
  })
}

/** Значение никогда не уходит наружу (в API/логи) — только внутренним сервисам. */
export async function getSecret(tenantId: string, provider: Provider, key: string): Promise<string | null> {
  return withTenant(tenantId, null, async (tx) => {
    // failing — тоже читаем: интеграция «мовчить», но должна суметь восстановиться при следующем удачном вызове
    const [row] = await tx.select().from(tenantSecrets).where(and(eq(tenantSecrets.provider, provider), eq(tenantSecrets.key, key), sql`${tenantSecrets.status} <> 'revoked'`))
    if (!row) return null
    try {
      return decrypt(row.valueEncrypted, row.nonce)
    }
    catch {
      return null
    }
  })
}

/** Состояние интеграции для интерфейса (docs/09 §9.3): без значений. */
export async function integrationStatus(ctx: Ctx, provider: Provider) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ key: tenantSecrets.key, accountLabel: tenantSecrets.accountLabel, status: tenantSecrets.status, lastOkAt: tenantSecrets.lastOkAt, lastError: tenantSecrets.lastError, updatedAt: tenantSecrets.updatedAt })
      .from(tenantSecrets).where(and(eq(tenantSecrets.provider, provider), sql`${tenantSecrets.status} <> 'revoked'`))
    const keys = Object.values(SECRET_KEYS[provider]) as string[]
    const present = new Set(rows.map(r => r.key))
    const configured = keys.filter(k => present.has(k))
    const failing = rows.find(r => r.status === 'failing')
    return {
      provider,
      configured: configured.length > 0,
      complete: keys.every(k => present.has(k)) || provider === 'sms' && present.has('api_key'),
      state: failing ? 'failing' : configured.length ? 'connected' : 'not_configured',
      accountLabel: rows.find(r => r.accountLabel)?.accountLabel ?? null,
      lastOkAt: rows.map(r => r.lastOkAt).filter(Boolean).sort().pop() ?? null,
      lastError: failing?.lastError ?? null,
      keys: keys.map(k => ({ key: k, set: present.has(k) })),
    }
  })
}

export async function disconnect(ctx: Ctx, provider: Provider) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    await tx.update(tenantSecrets).set({ status: 'revoked', updatedAt: new Date() }).where(eq(tenantSecrets.provider, provider))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'integration.disconnect', entity: 'tenant_secret', after: { provider } })
  })
}

export async function markSecretResult(tenantId: string, provider: Provider, ok: boolean, error?: string) {
  await withTenant(tenantId, null, async (tx) => {
    await tx.update(tenantSecrets).set(ok
      ? { status: 'active', lastOkAt: new Date(), lastError: null }
      : { status: 'failing', lastError: (error ?? 'unknown').slice(0, 500) },
    ).where(and(eq(tenantSecrets.provider, provider), eq(tenantSecrets.status, ok ? 'failing' : 'active')))
  })
}
