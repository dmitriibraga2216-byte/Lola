import { contentRatingSchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { rateContent } from '../../../services/contentRatings'
import { apiData, apiError } from '../../../utils/apiResponse'

/** PUT /content-ratings/:contentId — оценка 1–5 (докс/33 D-042); повторная — правит свою (upsert). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = contentRatingSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оцінка — від 1 до 5')
  const r = await rateContent({ tenantId: a.tenantId, actorId: a.userId }, { contentType: p.data.contentType, contentId: getRouterParam(event, 'contentId')!, value: p.data.value })
  if (!r) return apiError(event, 404, 'not_found', 'Матеріал не знайдено')
  return apiData(r)
})
