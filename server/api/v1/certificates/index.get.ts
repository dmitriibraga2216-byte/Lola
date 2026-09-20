import { certificateListQuerySchema } from '../../../../shared/schemas/quizzes'
import { requireScope } from '../../../services/access'
import { listCertificates } from '../../../services/certificates'
import { apiData, apiError } from '../../../utils/apiResponse'

/** GET /certificates?courseId=&status=active|revoked&q= — список виданих (докс/33 D-065). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const p = certificateListQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри фільтра')
  return apiData(await listCertificates({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
