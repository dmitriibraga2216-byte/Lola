import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { assignIssue, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { contentIssueAssignSchema } from '../../../../../shared/schemas/contentIssues'

/** POST /content-issues/:id/assign — переназначить (docs/v2/36 §2: только администратор). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.assign')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const p = contentIssueAssignSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть відповідального')
  const r = await assignIssue(await viewerOf(a), id.data, p.data.userId)
  if (r.ok) return apiData(r.card)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  return apiError(event, 400, 'validation_failed', 'Ця людина не може розбирати скарги: оберіть працівника з правом розбору')
})
