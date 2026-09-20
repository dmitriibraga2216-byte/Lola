import { scaleSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { createScale } from '../../../services/scales'
import { apiData, apiError } from '../../../utils/apiResponse'
/** POST /scales: шкала с уровнями; диапазоны — подряд от 0 до 100. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = scaleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте шкалу', { issues: p.error.issues })
  const r = await createScale({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) return apiError(event, 409, 'name_taken', 'Шкала з такою назвою вже є')
  return apiData(r.scale)
})
