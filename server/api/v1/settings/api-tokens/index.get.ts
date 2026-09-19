import { requireScope } from '../../../../services/access'
import { listTokens } from '../../../../services/apiTokens'
import { SCOPES } from '../../../../../shared/domain/roles'
import { apiData } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  return apiData({ tokens: await listTokens({ tenantId: a.tenantId, actorId: a.userId }), scopes: SCOPES })
})
