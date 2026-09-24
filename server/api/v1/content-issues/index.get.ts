import { requireScope } from '../../../services/access'
import { listQueue, viewerOf } from '../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../utils/apiResponse'
import { contentIssueQueueSchema } from '../../../../shared/schemas/contentIssues'

/**
 * GET /content-issues — очередь «Звіт про помилки» (docs/v2/36 §5.3, §10).
 *
 * Видимость — из роли (§2): администратор видит всё, методист — свой контент, керівник точки —
 * карточки, где хотя бы один заявитель с его точек. Сортировка — по числу жалоб: сначала то,
 * на что жалуются многие.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.view')
  const p = contentIssueQueueSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте фільтри', { issues: p.error.issues })
  return apiData(await listQueue(await viewerOf(a), p.data))
})
