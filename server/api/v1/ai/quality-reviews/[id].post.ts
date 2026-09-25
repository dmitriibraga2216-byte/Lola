import { aiQualityVerdictSchema } from '../../../../../shared/schemas/ai'
import { requireScope } from '../../../../services/access'
import { setQualityVerdict } from '../../../../services/aiQuality'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /ai/quality-reviews/:id — вердикт о выводе **модели** (`docs/v2/30` §3.6, §7.16, §10;
 * `ai.audit`): `correct | minor_error | major_error | harmful`. Повторный вердикт — пересмотр, след в журнале.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.audit')
  const p = aiQualityVerdictSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Оберіть вердикт', { issues: p.error.issues })
  const r = await setQualityVerdict({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Перевірку не знайдено')
})
