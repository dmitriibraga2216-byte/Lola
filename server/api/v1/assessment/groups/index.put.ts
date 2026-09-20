import { requireScope } from '../../../../services/access'
import { upsertGroup } from '../../../../services/assessment'
import { criteriaGroupSchema } from '../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = criteriaGroupSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте групу: назва обовʼязкова', { issues: p.error.issues })
  const r = await upsertGroup({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Групу не знайдено')
  return apiData(r)
})
