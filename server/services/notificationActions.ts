import { and, eq, sql } from 'drizzle-orm'
import { notifications } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { enqueueNotification, setPref } from './notifications'

/** Кнопки бота (docs/23 §7): «Відкласти на день» — максимум дважды; «Не нагадувати» — только необязательные. */
export async function snooze(tenantId: string, userId: string, notificationId: string): Promise<'ok' | 'limit' | 'not_found'> {
  return withTenant(tenantId, userId, async (tx) => {
    const [n] = await tx.select().from(notifications).where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    if (!n) return 'not_found'
    const p = n.payload as Record<string, unknown>
    const snoozed = Number(p.snoozed ?? 0)
    if (snoozed >= 2) return 'limit'
    const ok = await enqueueNotification(tx, { tenantId, userId, code: n.code, payload: { ...p, snoozed: snoozed + 1 }, dedupKey: `${n.dedupKey ?? n.id}:snooze${snoozed + 1}`, refType: n.refType ?? undefined, refId: n.refId ?? undefined })
    if (ok) await tx.update(notifications).set({ scheduledFor: sql`now() + interval '1 day'` }).where(and(eq(notifications.status, 'queued'), eq(notifications.dedupKey, `${n.dedupKey ?? n.id}:snooze${snoozed + 1}`)))
    await tx.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notificationId))
    return 'ok'
  })
}

export async function mute(tenantId: string, userId: string, notificationId: string): Promise<'ok' | 'mandatory' | 'not_found'> {
  const [n] = await withTenant(tenantId, userId, tx => tx.select({ code: notifications.code }).from(notifications).where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId))))
  if (!n) return 'not_found'
  const r = await setPref({ tenantId, actorId: userId }, { code: n.code, enabled: false })
  return r.ok ? 'ok' : r.code === 'mandatory' ? 'mandatory' : 'not_found'
}
