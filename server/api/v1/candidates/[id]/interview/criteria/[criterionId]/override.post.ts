import { interviewOverrideSchema } from '../../../../../../../../shared/schemas/interview'
import { requireScope } from '../../../../../../../services/access'
import { viewerOf } from '../../../../../../../services/candidates'
import { overrideCriterion } from '../../../../../../../services/interview/override'
import { apiData, apiError } from '../../../../../../../utils/apiResponse'

/**
 * POST /candidates/:id/interview/criteria/:criterionId/override — «Не погоджуюсь» (`docs/v2/30`
 * §6.4, §7.3, §10; `interview.override`). Балл человека ложится рядом с оценкой ИИ, в карточку —
 * новой оценкой `kind = 'manual'`; строка `kind = 'ai'` не меняется. `major` или отметка «груба
 * помилка моделі» — в очередь перепроверки качества. Двое спорят одновременно — `409 conflict` с
 * актуальным значением (§12 п. 6). Невидимый кандидат — `404` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.override')
  const p = interviewOverrideSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте форму', { issues: p.error.issues })
  const r = await overrideCriterion(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'criterionId')!, p.data)
  if (r.ok) return apiData(r.override)
  if (r.code === 'not_scored') return apiError(event, 409, 'session.not_scored', 'Оцінки ШІ за цим критерієм немає — оспорювати нічого, оцініть відповідь самостійно')
  if (r.code === 'out_of_scale') return apiError(event, 422, 'validation_failed', `Бал — від 0 до ${r.scaleMax}`, { scaleMax: r.scaleMax })
  if (r.code === 'conflict') return apiError(event, 409, 'conflict', 'Хтось щойно вже не погодився з цією оцінкою. Оновіть картку й перегляньте його бал', { current: r.current })
  return apiError(event, 404, 'not_found', 'Кандидата або критерій не знайдено')
})
