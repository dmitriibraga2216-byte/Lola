import { requireScope } from '../../../../../services/access'
import { submitTask } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.own')
  const r = await submitTask({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Завдання не знайдено', bad_status: 'Анкету вже надіслано', incomplete: 'Відповідайте на всі критерії або позначте «не застосовно»', comment_required: 'Оцінка нижче порогу — потрібен коментар' }
    return apiError(event, r.code === 'not_found' ? 404 : 422, `assessment.${r.code}`, msg[r.code]!, { criterionIds: r.criterionIds })
  }
  return apiData(r)
})
