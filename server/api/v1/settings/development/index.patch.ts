import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { updateDevelopmentSettings } from '../../../../services/developmentExtra'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Настройки модуля розвитку (docs/19 §7.4, §7.7, §7.9). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = z.object({ goalsNeedApproval: z.boolean().optional(), externalTrainingThreshold: z.number().min(0).max(10_000_000).optional(), careerAssessmentFormId: z.string().uuid().nullable().optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: p.error.issues })
  return apiData(await updateDevelopmentSettings({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
