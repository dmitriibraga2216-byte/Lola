import { z } from 'zod'

/**
 * Push-подписка браузера, PWA (docs/23 §4, докс/33 D-051): endpoint + ключи шифрования,
 * которые отдаёт `PushManager.subscribe()`. Ключи не используются в D-051 (пуш идёт без
 * зашифрованной полезной нагрузки — см. `server/services/push.ts`), но хранятся на будущее.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
})
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
})
