import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createWave } from '../../../../services/mystery'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Волна тайного покупателя (docs/20 §7.8): только руководители сети. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.tenant')
  const p = z.object({ checklistId: z.string().uuid(), title: z.string().min(2).max(200), startsAt: z.string().date(), endsAt: z.string().date() }).refine(x => x.endsAt >= x.startsAt, { message: 'Кінець раніше початку', path: ['endsAt'] }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const w = await createWave({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!w) return apiError(event, 400, 'invalid', 'Чек-лист має бути типу «таємний покупець»')
  return apiData(w)
})
