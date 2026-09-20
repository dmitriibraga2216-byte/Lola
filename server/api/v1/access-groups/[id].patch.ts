import { accessGroupSchema } from '../../../../shared/schemas/resources'
import { requireScope } from '../../../services/access'
import { updateAccessGroup } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = accessGroupSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля групи доступу', { issues: p.error.issues })
  const r = await updateAccessGroup({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Групу доступу не знайдено')
  return apiData(r)
})
