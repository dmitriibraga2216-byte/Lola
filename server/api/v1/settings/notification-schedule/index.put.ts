import { z } from 'zod'
import { notificationSchedulePatchSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { updateNotificationSchedule, updateQuietHours } from '../../../../services/settings'
import { apiData, apiError } from '../../../../utils/apiResponse'

const schema = z.object({
  quietHours: z.object({ enabled: z.boolean().optional(), from: z.number().int().min(0).max(23).optional(), to: z.number().int().min(1).max(24).optional() }).optional(),
  schedule: notificationSchedulePatchSchema.optional(),
})

/**
 * PUT /settings/notification-schedule (docs/23 §13.2.1: «Налаштування часу відправлення повідомлень» —
 * зміна впливає на час відправлення всім користувачам). Тихі часи лежать у своїй групі `quietHours`,
 * час по класах подій — у `notificationSchedule`; пишемо обидві разом, як екран еталона.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (p.data.quietHours) await updateQuietHours(ctx, p.data.quietHours)
  if (p.data.schedule) await updateNotificationSchedule(ctx, p.data.schedule as never)
  return apiData({ ok: true })
})
