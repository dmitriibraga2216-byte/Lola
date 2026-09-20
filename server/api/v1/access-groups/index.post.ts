import { accessGroupSchema } from '../../../../shared/schemas/resources'
import { requireAnyScope } from '../../../services/access'
import { createAccessGroup } from '../../../services/resources'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const p = accessGroupSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля групи доступу', { issues: p.error.issues })
  const a = await requireAnyScope(event, [p.data.appliesTo === 'catalog' ? 'assignment.create' : 'knowledge.manage'])
  return apiData(await createAccessGroup({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
