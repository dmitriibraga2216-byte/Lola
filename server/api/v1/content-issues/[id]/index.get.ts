import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { getCard, viewerOf } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /content-issues/:id — карточка жалобы (docs/v2/36 §5.4): заявители с контекстом, журнал,
 * «Вплив на результати» и кнопки, доступные этому человеку. Чужая или невидимая карточка —
 * 404, а не 403 (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.view')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const card = await getCard(await viewerOf(a), id.data)
  if (!card) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  return apiData(card)
})
