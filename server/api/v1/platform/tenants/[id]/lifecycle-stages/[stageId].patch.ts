import { stageCapabilitiesPatchSchema } from '../../../../../../../shared/schemas/lifecycle'
import { setStageCapabilities } from '../../../../../../services/lifecycle'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../../utils/platformGuard'

/**
 * PATCH /platform/tenants/:id/lifecycle-stages/:stageId — смена набора возможностей этапа.
 *
 * Возможности меняет **только оператор платформы** (docs/v2/33 §2): «отдавать их тенанту
 * означает позволить ему сломать продукт настройкой». Неизвестный ключ отвергается
 * `422 validation_failed` (docs/v2/44 В-3), а не игнорируется.
 */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'tenant.update')
  const tenantId = getRouterParam(event, 'id')!
  const stageId = getRouterParam(event, 'stageId')!
  const p = stageCapabilitiesPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Невідомий ключ можливості етапу', { issues: p.error.issues })
  const r = await setStageCapabilities(tenantId, stageId, p.data.capabilities)
  if (typeof r === 'string') return apiError(event, 404, 'not_found', 'Етап не знайдено')
  return apiData(r)
})
