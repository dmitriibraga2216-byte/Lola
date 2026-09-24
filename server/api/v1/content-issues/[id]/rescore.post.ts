import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { rescoreIssue, viewerOf } from '../../../../services/contentIssueTriage'
import type { RescoreError } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { contentIssueRescoreSchema } from '../../../../../shared/schemas/contentIssues'

/**
 * POST /content-issues/:id/rescore — «Перерахувати результати» из карточки (docs/v2/36 §7.8,
 * П-12.4): вторая точка входа в ту же логику, что у «Перерахувати» отчёта по тесту. Результат
 * может только улучшиться; ухудшения возвращаются отдельным списком `worse`.
 */
const ERRORS: Record<RescoreError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Скаргу не знайдено'],
  not_a_quiz_issue: [409, 'content_issue.not_a_quiz_issue', 'Перерахунок можливий лише для скарг на питання тесту'],
  resolution_required: [400, 'content_issue.resolution_required', 'Спершу позначте скаргу: «Питання виправлено» або «Питання анульовано»'],
  already_rescored: [409, 'content_issue.already_rescored', 'Результати вже перераховано — для нового перерахунку потрібна нова скарга'],
  in_progress: [409, 'content_issue.already_rescored', 'Перерахунок уже виконується — зачекайте кілька хвилин'],
}

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.rescore')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const p = contentIssueRescoreSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Вкажіть причину перерахунку')
  const r = await rescoreIssue(await viewerOf(a), id.data, p.data)
  if (r.ok) return apiData(r.result)
  const [status, code, message] = ERRORS[r.code]
  return apiError(event, status, code, message)
})
