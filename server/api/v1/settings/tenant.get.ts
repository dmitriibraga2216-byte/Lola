import { MODULES } from '../../../../shared/schemas/settings'
import { requireScope } from '../../../services/access'
import { moduleLock } from '../../../services/modules'
import { tenantSpace } from '../../../services/settings'
import { apiData } from '../../../utils/apiResponse'
/** GET /settings/tenant (docs/24 §3.1, §9): простір, бренд, slug, модули, значения по умолчанию. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const space = await tenantSpace({ tenantId: a.tenantId, actorId: a.userId })
  // Замок модуля по тарифу (docs/24 §3.2, §4.4; докс/33 D-053): підпис «Доступно на тарифі …» в екрані модулів.
  const lockedModules: Record<string, string> = {}
  for (const m of MODULES) {
    const lock = await moduleLock(a.tenantId, m)
    if (lock) lockedModules[m] = lock.planName
  }
  return apiData({ ...space, lockedModules })
})
