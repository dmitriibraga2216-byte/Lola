import { requireScope } from '../../../../../../services/access'
import { markSpamApplication } from '../../../../../../services/publicApply'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** POST /vacancies/:id/applications/:aid/spam — пометка «спам» (docs/v2/29 §7.7, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const r = await markSpamApplication(
    { tenantId: a.tenantId, actorId: a.userId },
    getRouterParam(event, 'id')!,
    getRouterParam(event, 'aid')!,
  )
  if (r.ok) return apiData({ state: r.state })
  return apiError(event, 404, 'not_found', 'Відгук не знайдено')
})
