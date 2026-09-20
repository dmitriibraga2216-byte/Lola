import { tenantPurgeSchema } from '../../../../../../shared/schemas/platform'
import { requirePlatform, tenantActionError } from '../../../../../utils/platformGuard'
import { schedulePurge } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** POST /platform/tenants/:id/purge {confirmSlug} — команда на удаление через 30 дней (docs/25 §8, docs/24 §7 п. 5). */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = tenantPurgeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Введіть slug простору для підтвердження')
  const r = await schedulePurge(getRouterParam(event, 'id')!, p.data.confirmSlug, actor)
  return r.ok ? apiData(r) : tenantActionError(event, r.code)
})
