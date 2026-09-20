import { scaleSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateScale } from '../../../services/scales'
import { apiData, apiError } from '../../../utils/apiResponse'
/** PUT /scales/:id: шкала пересобирается целиком. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = scaleSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте шкалу', { issues: p.error.issues })
  const r = await updateScale({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Шкалу не знайдено') : apiError(event, 409, 'name_taken', 'Шкала з такою назвою вже є')
  return apiData(r.scale)
})
