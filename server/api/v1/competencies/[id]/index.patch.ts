import { requireScope } from '../../../../services/access'
import { updateCompetency } from '../../../../services/development'
import { competencySchema } from '../index.post'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'competency.manage')
  const p = competencySchema.partial().extend({ isActive: (await import('zod')).z.boolean().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте компетенцію')
  const r = await updateCompetency({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Компетенцію не знайдено')
  return apiData(r)
})
