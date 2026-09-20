import { modulesPatchSchema } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { updateModules } from '../../../services/settings'
import { invalidateModules } from '../../../services/modules'
import { apiData, apiError } from '../../../utils/apiResponse'
/** PATCH /settings/modules: выключенный модуль исчезает из меню и API (403 module.disabled), данные остаются. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = modulesPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте модулі', { issues: p.error.issues })
  const r = await updateModules({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  invalidateModules(a.tenantId)
  return apiData(r)
})
