import { applicationRejectSchema } from '../../../../../../../shared/schemas/publicApply'
import { requireScope } from '../../../../../../services/access'
import { rejectApplication } from '../../../../../../services/publicApply'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** POST /vacancies/:id/applications/:aid/reject — отказ по отклику (docs/v2/29 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = applicationRejectSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть причину відмови')
  const r = await rejectApplication(
    { tenantId: a.tenantId, actorId: a.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'aid')!,
    p.data.reason,
  )
  if (r.ok) return apiData({ state: r.state })
  return apiError(event, 404, 'not_found', 'Відгук не знайдено')
})
