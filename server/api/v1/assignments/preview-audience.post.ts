import { z } from 'zod'
import { audienceSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { previewAudience } from '../../../services/assignments'
import { apiData, apiError } from '../../../utils/apiResponse'

const body = z.object({ audience: audienceSchema, exclude: audienceSchema.optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = body.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірні умови', { issues: p.error.issues })
  return apiData(await previewAudience({ tenantId: a.tenantId, actorId: a.userId }, p.data.audience, p.data.exclude))
})
