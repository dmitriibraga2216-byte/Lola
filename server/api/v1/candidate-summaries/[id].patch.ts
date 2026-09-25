import { candidateSummaryPatchSchema } from '../../../../shared/schemas/candidateSummaries'
import { can, requireScope } from '../../../services/access'
import { viewerOf } from '../../../services/candidates'
import { patchSummary } from '../../../services/candidateSummaries'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * PATCH /candidate-summaries/:id — «Редагувати» (`docs/v2/30` §5.4, §10; `summary.edit`): секции и
 * текст «сильних сторін і зон ризику», `generated_by = 'ai_edited'`. Строку «Документ сформовано
 * автоматично» не снимает ни эта ручка, ни настройка тенанта: поля для неё в контракте нет.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.edit')
  const p = candidateSummaryPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте зміни', { issues: p.error.issues })
  const r = await patchSummary(viewerOf(a), getRouterParam(event, 'id')!, p.data, can(a, 'summary.send'))
  if (r.ok) return apiData(r.summary)
  if (r.code === 'sent') return apiError(event, 409, 'summary.sent', 'Підсумок уже надіслано. Редагування неможливе — сформуйте нову версію')
  if (r.code === 'not_editable') return apiError(event, 409, 'summary.not_editable', 'Цю версію не можна редагувати: вона ще збирається, відкликана або стерта')
  return apiError(event, 404, 'not_found', 'Підсумок не знайдено')
})
