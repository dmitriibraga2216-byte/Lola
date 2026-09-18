import { requireScope } from '../../../services/access'
import { myCertificates } from '../../../services/certificates'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  return apiData(await myCertificates({ tenantId: a.tenantId, actorId: a.userId }))
})
