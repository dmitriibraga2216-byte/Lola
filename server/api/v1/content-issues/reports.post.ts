import { can, requireScope } from '../../../services/access'
import { submitReport } from '../../../services/contentIssues'
import { apiData, apiError } from '../../../utils/apiResponse'
import { contentReportSchema } from '../../../../shared/schemas/contentIssues'

/**
 * POST /content-issues/reports — подать жалобу на материал (docs/v2/36 §10).
 *
 * Эндпоинт тонкий (CLAUDE.md п. 6): валидация → сервис → сериализация. Все коды ответа —
 * из §10 и §6.1, каждый отказ объясняет, что делать:
 * 400 `validation_failed`, 404 чужой тенант (не 403, правило 15),
 * 409 `content_issue.already_reported`, 423 `content_issue.reporter_muted`,
 * 429 `content_issue.rate_limited` — с числом поданных и пределом в `details`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.report')
  const p = contentReportSchema.safeParse(await readBody(event))
  if (!p.success) {
    return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля форми')
  }

  const r = await submitReport(
    { tenantId: a.tenantId, actorId: a.userId },
    p.data,
    // Носители `content_issue.triage` разбирают очередь — лимиты частоты их не касаются (§7.10)
    { exemptFromLimits: can(a, 'content_issue.triage') },
  )

  if (r.ok) return apiData(r.result)
  switch (r.code) {
    case 'not_found':
      return apiError(event, 404, 'not_found', 'Матеріал не знайдено')
    case 'already_reported':
      return apiError(event, 409, 'content_issue.already_reported', 'Ти вже повідомляв про це', { issueId: r.issueId })
    case 'reporter_muted':
      return apiError(event, 423, 'content_issue.reporter_muted', 'Надсилання повідомлень тимчасово недоступне', { until: r.until })
    case 'rate_limited':
      return apiError(event, 429, 'content_issue.rate_limited', 'Ліміт повідомлень вичерпано', { reason: r.reason, used: r.used, limit: r.limit })
  }
})
