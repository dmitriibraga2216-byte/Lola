import { tenantPatchSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { updateTenant } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** PATCH /platform/tenants/:id — тариф, триал, название, settings. Статус — только suspend/resume/purge (docs/25 §8). */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = tenantPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const r = await updateTenant(getRouterParam(event, 'id')!, p.data, actor)
  if (!r) return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  return apiData(r)
})
