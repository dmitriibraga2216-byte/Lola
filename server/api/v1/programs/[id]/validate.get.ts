import { requireScope } from '../../../../services/access'
import { validateProgram } from '../../../../services/programs'
import { withTenant } from '../../../../utils/withTenant'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  return apiData(await withTenant(a.tenantId, a.userId, tx => validateProgram(tx, getRouterParam(event, 'id')!)))
})
