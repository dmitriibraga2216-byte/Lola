import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { assessCompetency } from '../../../../services/development'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ userId: z.string().uuid(), level: z.number().int().min(1).max(5), source: z.enum(['self', 'manager']).default('manager'), comment: z.string().max(500).optional(), validMonths: z.number().int().min(1).max(36).optional() })
export default defineEventHandler(async (event) => {
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте оцінку')
  const a = await requireScope(event, p.data.source === 'self' ? 'development.own' : 'development.team')
  if (p.data.source === 'self' && p.data.userId !== a.userId) return apiError(event, 403, 'forbidden', 'Самооцінка — лише собі')
  const r = await assessCompetency({ tenantId: a.tenantId, actorId: a.userId }, { ...p.data, competencyId: getRouterParam(event, 'id')! })
  if (!r) return apiError(event, 422, 'validation_failed', 'Рівень поза шкалою компетенції')
  return apiData(r)
})
