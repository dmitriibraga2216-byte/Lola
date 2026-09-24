import { requireScope } from '../../../../services/access'
import { subordinatesOf } from '../../../../services/orgManager'
import { withTenant } from '../../../../utils/withTenant'
import { apiData } from '../../../../utils/apiResponse'

/** GET /org-structure/subordinates/:userId?deep=true (docs/v2/32 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.view')
  const userId = getRouterParam(event, 'userId')!
  const deep = String(getQuery(event).deep ?? '') === 'true'
  const ids = await withTenant(a.tenantId, a.userId, tx => subordinatesOf(tx, userId, deep))
  return apiData({ userIds: ids })
})
