import { requireScope } from '../../../services/access'
import { certificatesSummary } from '../../../services/certificates'
import { apiData } from '../../../utils/apiResponse'
/** GET /certificates/summary — экран «Сертифікати» (мокап Certificates): по курсам — выдано, срок, последняя выдача. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  return apiData(await certificatesSummary({ tenantId: a.tenantId, actorId: a.userId }))
})
