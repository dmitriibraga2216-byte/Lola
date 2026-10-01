import { createHash } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { idempotencyKeys } from '../db/schema'
import { withTenant } from '../utils/withTenant'

/**
 * Идемпотентность мутаций по заголовку `Idempotency-Key` (docs/04 §4.1, docs/v2/44 §18 Р-CC.3).
 *
 * Первый запрос с ключом занимает строку (ответа ещё нет), выполняется и записывает ответ.
 * Повтор того же запроса с тем же ключом в течение 24 часов получает **сохранённый** ответ —
 * мутация второй раз не выполняется. Тот же ключ с другим запросом — `mismatch`; повтор, пока
 * первый ещё выполняется, — `in_progress`. Ответ 5xx и брошенное исключение не сохраняются:
 * ключ освобождается, и клиент может повторить запрос — сбой сервера не должен «запечатать» ключ.
 */

interface Ctx { tenantId: string, actorId: string }

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000
/** Печатные ASCII без пробелов, до 255 знаков: UUID клиента и любые разумные ключи. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,255}$/

/** Отпечаток запроса: метод, путь с запросом и тело. Ключи тела сортируются — порядок полей не важен. */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
    return v
  }
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${JSON.stringify(stable(body ?? null))}`).digest('hex')
}

export type IdempotencyBegin
  = | { kind: 'fresh', id: string }
    | { kind: 'replay', status: number, body: unknown }
    | { kind: 'in_progress' }
    | { kind: 'mismatch' }

export async function beginIdempotent(ctx: Ctx, key: string, fingerprint: string, now = new Date()): Promise<IdempotencyBegin> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const own = and(eq(idempotencyKeys.tenantId, ctx.tenantId), eq(idempotencyKeys.userId, ctx.actorId), eq(idempotencyKeys.key, key))
    // Истёкший ключ — как не бывший: уборка раз в сутки, а 24 часа считаются от первого запроса
    await tx.delete(idempotencyKeys).where(and(own, lt(idempotencyKeys.expiresAt, now)))
    const [row] = await tx.insert(idempotencyKeys).values({
      tenantId: ctx.tenantId, userId: ctx.actorId, key, fingerprint, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
    }).onConflictDoNothing().returning({ id: idempotencyKeys.id })
    if (row) return { kind: 'fresh', id: row.id }
    const [cur] = await tx.select().from(idempotencyKeys).where(and(own, gt(idempotencyKeys.expiresAt, now)))
    if (!cur) return { kind: 'in_progress' } // занят параллельной транзакцией, которая ещё не видна
    if (cur.fingerprint !== fingerprint) return { kind: 'mismatch' }
    if (cur.responseStatus == null) return { kind: 'in_progress' }
    return { kind: 'replay', status: cur.responseStatus, body: cur.responseBody }
  })
}

/** Ответ < 500 запоминается; иначе ключ освобождается для повтора. */
export async function finishIdempotent(ctx: Ctx, id: string, status: number, body: unknown): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (status >= 500) await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id))
    else await tx.update(idempotencyKeys).set({ responseStatus: status, responseBody: body ?? null, updatedAt: new Date() }).where(eq(idempotencyKeys.id, id))
  })
}

export async function releaseIdempotent(ctx: Ctx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id)))
}

/** `idempotency.purge` (ежедневно): истёкшие ключи тенанта. */
export async function purgeIdempotencyKeys(tenantId: string, now = new Date()): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, tenantId), lt(idempotencyKeys.expiresAt, now))).returning({ id: idempotencyKeys.id })
    return rows.length
  })
}

