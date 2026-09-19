import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { apiTokens } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { hitRateLimit } from './rateLimit'

interface Ctx { tenantId: string, actorId: string }

/**
 * API-токены тенанта (docs/04 §4.1, docs/09 §9.6): Bearer со скоупами,
 * показывается один раз, 60 запросов/мин на токен.
 */

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

export async function listTokens(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, scopes: apiTokens.scopes, lastUsedAt: apiTokens.lastUsedAt, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt, createdAt: apiTokens.createdAt })
      .from(apiTokens).orderBy(sql`${apiTokens.createdAt} desc`)
  })
}

export async function createToken(ctx: Ctx, input: { name: string, scopes: string[], expiresInDays?: number | null }) {
  const raw = `lola_${randomBytes(32).toString('base64url')}`
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.insert(apiTokens).values({
      tenantId: ctx.tenantId, name: input.name, tokenHash: hash(raw), prefix: raw.slice(0, 12), scopes: input.scopes,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null, createdBy: ctx.actorId,
    }).returning({ id: apiTokens.id })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'api_token.create', entity: 'api_token', entityId: t!.id, after: { name: input.name, scopes: input.scopes } })
    return { id: t!.id, token: raw }
  })
}

export async function revokeToken(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.update(apiTokens).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(apiTokens.id, id)).returning({ id: apiTokens.id })
    if (t) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'api_token.revoke', entity: 'api_token', entityId: id })
    return t ?? null
  })
}

export interface TokenAuth { tokenId: string, tenantId: string, scopes: string[], actorId: string | null }

/** Проверка Bearer до контекста тенанта. Возвращает null или причину отказа. */
export async function validateBearer(raw: string): Promise<{ ok: true, auth: TokenAuth } | { ok: false, code: 'invalid' | 'rate_limited' }> {
  const rows = await db.execute(sql`select * from auth_api_token(${hash(raw)})`) as unknown as { token_id: string, tenant_id: string, scopes: string[], expires_at: string | null, revoked_at: string | null, created_by: string | null }[]
  const row = rows[0]
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) < new Date())) return { ok: false, code: 'invalid' }
  if (!await hitRateLimit(`api:${row.token_id}`, 60, 60)) return { ok: false, code: 'rate_limited' }
  await withTenant(row.tenant_id, null, async (tx) => {
    await tx.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token_id))
  }).catch(() => {})
  return { ok: true, auth: { tokenId: row.token_id, tenantId: row.tenant_id, scopes: row.scopes, actorId: row.created_by } }
}
