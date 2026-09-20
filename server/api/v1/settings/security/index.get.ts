import { requireScope } from '../../../../services/access'
import { securitySettings } from '../../../../services/securityLog'
import { withTenant } from '../../../../utils/withTenant'
import { apiData } from '../../../../utils/apiResponse'
/** Настройки журнала безпеки (docs/22 §13.4): «Повідомляти про зміни на E-mail». */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  return apiData(await withTenant(a.tenantId, a.userId, tx => securitySettings(tx, a.tenantId)))
})
