import { requireScope } from '../../../services/access'
import { listCertificates } from '../../../services/certificates'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  return apiData(await listCertificates({ tenantId: a.tenantId, actorId: a.userId }))
})
