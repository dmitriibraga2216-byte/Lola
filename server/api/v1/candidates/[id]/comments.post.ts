import { candidateCommentSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { addComment, viewerOf } from '../../../../services/candidates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** POST /candidates/:id/comments — комментарий о кандидате (docs/v2/28 §3.5, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = candidateCommentSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте коментар', { issues: p.error.issues })
  const r = await addComment(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
  return apiData(r)
})
