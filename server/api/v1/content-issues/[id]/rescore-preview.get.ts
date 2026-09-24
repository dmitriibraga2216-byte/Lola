import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { rescorePreview, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { CONTENT_ISSUE_RESCORE_MODES } from '../../../../../shared/schemas/contentIssues'

/**
 * GET /content-issues/:id/rescore-preview — сколько попыток изменится (docs/v2/36 §7.8, §10).
 * Считает та же функция, что и применяет (`planRecalc`), — только без записи.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.rescore')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const mode = z.enum(CONTENT_ISSUE_RESCORE_MODES).optional().safeParse(getQuery(event).mode)
  const r = await rescorePreview(await viewerOf(a), id.data, mode.success ? mode.data : undefined)
  if (r.ok) return apiData(r.preview)
  if (r.code === 'not_a_quiz_issue') return apiError(event, 409, 'content_issue.not_a_quiz_issue', 'Перерахунок можливий лише для скарг на питання тесту')
  return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
})
