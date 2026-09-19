import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createCareerRequest, createExternalRequest } from '../../../../services/requests'
import { apiData, apiError } from '../../../../utils/apiResponse'
const ext = z.object({ kind: z.literal('external'), title: z.string().min(3).max(200), provider: z.string().max(200).optional(), format: z.enum(['online', 'offline']).default('online'), startsAt: z.string().date().optional(), cost: z.number().min(0).optional(), currency: z.string().length(3).optional(), justification: z.string().max(2000).optional(), expectedResult: z.string().max(2000).optional() })
const car = z.object({ kind: z.literal('career'), targetPositionId: z.string().uuid(), targetLocationId: z.string().uuid().optional(), motivation: z.string().max(2000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.own')
  const p = z.discriminatedUnion('kind', [ext, car]).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте заявку', { issues: p.error.issues })
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  return apiData(p.data.kind === 'external' ? await createExternalRequest(ctx, p.data) : await createCareerRequest(ctx, p.data))
})
