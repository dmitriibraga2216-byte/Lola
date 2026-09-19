import { z } from 'zod'
import { audienceSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { broadcast } from '../../../services/notifications'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Ручная рассылка (docs/23 §5.4): руководитель/админ, до 500 знаков, попадает в журнал как manual. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = z.object({ audience: audienceSchema, text: z.string().min(3).max(500), channel: z.enum(['telegram', 'sms', 'email']).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте розсилку', { issues: p.error.issues })
  return apiData(await broadcast({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
