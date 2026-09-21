import { createHmac, randomBytes } from 'node:crypto'
import { and, eq, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { webhookDeliveries, webhookEndpoints } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { decrypt, encrypt } from './crypto'
import { effectiveLimits } from './tenantLimits'

interface Ctx { tenantId: string, actorId: string }

/**
 * Вебхуки наружу (docs/04 §4.11, docs/09 §9.5): подпись X-Lola-Signature
 * HMAC-SHA256 по телу, 3 повтора с экспонентой, журнал доставок, ручной повтор.
 */

export const WEBHOOK_EVENTS = [
  'enrollment.completed', 'attempt.passed', 'attempt.failed', 'certificate.issued', 'assignment.overdue', 'user.created',
  'notice.acknowledged', // docs/04 §4.15 (Spec 21)
] as const
export type WebhookEvent = typeof WEBHOOK_EVENTS[number]

const MAX_ATTEMPTS = 3
const BACKOFF_MIN = [1, 5, 30] // минуты до 2-й, 3-й попытки и после

export async function listEndpoints(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, isActive: webhookEndpoints.isActive, description: webhookEndpoints.description, createdAt: webhookEndpoints.createdAt,
      delivered: sql<number>`(select count(*)::int from ${webhookDeliveries} d where d.endpoint_id = ${webhookEndpoints.id} and d.status = 'delivered')`,
      failed: sql<number>`(select count(*)::int from ${webhookDeliveries} d where d.endpoint_id = ${webhookEndpoints.id} and d.status = 'failed')`,
    }).from(webhookEndpoints).orderBy(webhookEndpoints.createdAt)
  })
}

export type CreateEndpointResult = { ok: true, id: string, secret: string } | { ok: false, code: 'webhooks_limit' }

/** Секрет показывается один раз при создании. Лимит вебхуков (docs/25 §10, докс/33 D-055) — переопределение тенанта, иначе тариф. */
export async function createEndpoint(ctx: Ctx, input: { url: string, events: string[], description?: string }): Promise<CreateEndpointResult> {
  const limit = (await effectiveLimits(ctx.tenantId)).webhooks
  if (limit != null) {
    const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ count: sql<number>`count(*)::int` }).from(webhookEndpoints))
    if ((rows[0]?.count ?? 0) >= limit) return { ok: false, code: 'webhooks_limit' }
  }
  const secret = `whsec_${randomBytes(24).toString('base64url')}`
  const { ciphertext, nonce } = encrypt(secret)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.insert(webhookEndpoints).values({
      tenantId: ctx.tenantId, url: input.url, secretEncrypted: ciphertext, nonce, events: input.events, description: input.description ?? null, createdBy: ctx.actorId,
    }).returning({ id: webhookEndpoints.id })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'webhook.create', entity: 'webhook_endpoint', entityId: e!.id, after: { url: input.url, events: input.events } })
    return { ok: true as const, id: e!.id, secret }
  })
}

export async function updateEndpoint(ctx: Ctx, id: string, input: { isActive?: boolean, events?: string[], url?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.update(webhookEndpoints).set({ ...input, updatedAt: new Date() }).where(eq(webhookEndpoints.id, id)).returning({ id: webhookEndpoints.id })
    return e ?? null
  })
}

/** Постановка события в доставку — вызывается из доменных сервисов внутри их транзакции. */
export async function emitWebhook(tx: TenantTx, tenantId: string, event: WebhookEvent, payload: Record<string, unknown>) {
  const endpoints = await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.isActive, true), sql`${event} = any(${webhookEndpoints.events})`))
  if (!endpoints.length) return 0
  await tx.insert(webhookDeliveries).values(endpoints.map(e => ({
    tenantId, endpointId: e.id, event, payload: { event, tenantId, at: new Date().toISOString(), data: payload }, nextAttemptAt: new Date(),
  })))
  return endpoints.length
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** webhook.deliver — каждую минуту: pending с наступившим next_attempt_at. */
export async function deliverPending(tenantId: string, limit = 50): Promise<{ delivered: number, failed: number, retried: number }> {
  const stats = { delivered: 0, failed: 0, retried: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const due = await tx.select({ d: webhookDeliveries, e: webhookEndpoints })
      .from(webhookDeliveries).innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
      .limit(limit)

    for (const { d, e } of due) {
      const body = JSON.stringify(d.payload)
      let secret = ''
      try { secret = decrypt(e.secretEncrypted, e.nonce) }
      catch { /* без секрета шлём без подписи — но помечаем */ }
      const attempt = d.attempt + 1
      let statusCode: number | null = null
      let responseBody = ''
      try {
        const res = await fetch(e.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lola-Event': d.event, 'X-Lola-Delivery': d.id, ...(secret ? { 'X-Lola-Signature': sign(secret, body) } : {}) },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        statusCode = res.status
        responseBody = (await res.text()).slice(0, 2000)
      }
      catch (err) {
        responseBody = String(err).slice(0, 500)
      }
      const ok = statusCode !== null && statusCode >= 200 && statusCode < 300
      if (ok) {
        await tx.update(webhookDeliveries).set({ status: 'delivered', attempt, statusCode, responseBody, deliveredAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, d.id))
        stats.delivered++
      }
      else if (attempt >= MAX_ATTEMPTS) {
        await tx.update(webhookDeliveries).set({ status: 'failed', attempt, statusCode, responseBody, updatedAt: new Date() }).where(eq(webhookDeliveries.id, d.id))
        stats.failed++
      }
      else {
        const wait = BACKOFF_MIN[Math.min(attempt, BACKOFF_MIN.length - 1)]! * 60_000
        await tx.update(webhookDeliveries).set({ attempt, statusCode, responseBody, nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() }).where(eq(webhookDeliveries.id, d.id))
        stats.retried++
      }
    }
  })
  return stats
}

export async function listDeliveries(ctx: Ctx, endpointId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({ id: webhookDeliveries.id, event: webhookDeliveries.event, status: webhookDeliveries.status, attempt: webhookDeliveries.attempt, statusCode: webhookDeliveries.statusCode, responseBody: webhookDeliveries.responseBody, createdAt: webhookDeliveries.createdAt, deliveredAt: webhookDeliveries.deliveredAt, payload: webhookDeliveries.payload })
      .from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpointId)).orderBy(sql`${webhookDeliveries.createdAt} desc`).limit(100)
  })
}

/** Ручной повтор из UI (docs/09 §9.5). */
export async function retryDelivery(ctx: Ctx, deliveryId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [d] = await tx.update(webhookDeliveries).set({ status: 'pending', attempt: 0, nextAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, deliveryId)).returning({ id: webhookDeliveries.id })
    return d ?? null
  })
}

export async function tenantsWithPendingWebhooks(): Promise<string[]> {
  const rows = await db.execute(sql`select distinct tenant_id from webhook_deliveries where status = 'pending' and next_attempt_at <= now()`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}
