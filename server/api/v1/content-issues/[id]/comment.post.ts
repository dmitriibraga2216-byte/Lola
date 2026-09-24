import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { commentIssue, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { contentIssueCommentSchema } from '../../../../../shared/schemas/contentIssues'

/** POST /content-issues/:id/comment — комментарий в журнал карточки (docs/v2/36 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.view')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const p = contentIssueCommentSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Коментар — від 1 до 2000 символів')
  const r = await commentIssue(await viewerOf(a), id.data, p.data)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  return apiData(r.card)
})
