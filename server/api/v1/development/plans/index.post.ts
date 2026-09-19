import { z } from 'zod'
import { requireScope, can } from '../../../../services/access'
import { createPlan } from '../../../../services/development'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ userId: z.string().uuid().optional(), periodFrom: z.string().date(), periodTo: z.string().date(), summary: z.string().max(2000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть період', { issues: p.error.issues })
  const userId = p.data.userId ?? a.userId
  if (userId !== a.userId && !can(a, 'development.team')) return apiError(event, 403, 'forbidden', 'Немає доступу')
  if (p.data.periodTo <= p.data.periodFrom) return apiError(event, 422, 'validation_failed', 'Кінець періоду має бути пізніше початку')
  return apiData(await createPlan({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, userId }))
})
