import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { recruiterSummaryPdf } from '../../../../services/candidateSummaries'
import { apiError } from '../../../../utils/apiResponse'

/**
 * GET /candidate-summaries/:id/pdf — «Завантажити PDF» (`docs/v2/30` §3.5, §5.4; `summary.view`):
 * документ так, как его увидит кандидат, — включённые разделы, без ПД третьих лиц, со строкой
 * «Документ сформовано автоматично». Стёртый — `410 summary.redacted`, невидимый кандидат — `404`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.view')
  const r = await recruiterSummaryPdf(viewerOf(a), getRouterParam(event, 'id')!)
  if (!r.ok) {
    return r.code === 'redacted'
      ? apiError(event, 410, 'summary.redacted', 'Текст документа стерто: кандидат відкликав згоду або дані знеособлено')
      : apiError(event, 404, 'not_found', 'Підсумок не знайдено')
  }
  setHeader(event, 'Content-Type', 'application/pdf')
  setHeader(event, 'Content-Disposition', `attachment; filename="${r.fileName}"`)
  return r.pdf
})
