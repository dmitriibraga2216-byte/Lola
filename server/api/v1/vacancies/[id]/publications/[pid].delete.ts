import { requireScope } from '../../../../../services/access'
import { viewerOf } from '../../../../../services/vacancies'
import { removePublication } from '../../../../../services/vacancyPublications'
import { apiError } from '../../../../../utils/apiResponse'

/** DELETE /vacancies/:id/publications/:pid — снятие публикации (docs/v2/29 §7.13, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.publish')
  const r = await removePublication(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'pid')!)
  if (r.ok) { setResponseStatus(event, 204); return null }
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Публікацію не знайдено')
  return apiError(event, 409, 'publication.not_active', 'Публікація вже знята')
})
