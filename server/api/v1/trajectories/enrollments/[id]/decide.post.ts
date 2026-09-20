import { catalogDecideSchema } from '../../../../../../shared/schemas/catalog'
import { requireScope } from '../../../../../services/access'
import { decideRequest } from '../../../../../services/trajectories'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Решение по заявке из каталога (catalog_request). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = catalogDecideSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть approve', { issues: p.error.issues })
  const r = await decideRequest({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.approve, p.data.reason)
  if (!r.ok) return r.code === 'not_found' ? apiError(event, 404, 'not_found', 'Заявку не знайдено') : apiError(event, 409, 'trajectory.not_requested', 'Це не заявка або рішення вже ухвалено')
  return apiData(r)
})
