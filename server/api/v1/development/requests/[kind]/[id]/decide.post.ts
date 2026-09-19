import { z } from 'zod'
import { requireScope, can } from '../../../../../../services/access'
import { decideRequest } from '../../../../../../services/requests'
import { apiData, apiError } from '../../../../../../utils/apiResponse'
const schema = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'request.decide')
  const kind = getRouterParam(event, 'kind') as 'external' | 'career'
  if (!['external', 'career'].includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий тип')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть рішення')
  if (p.data.decision === 'reject' && (p.data.comment ?? '').length < 5) return apiError(event, 422, 'validation_failed', 'При відмові потрібен коментар')
  const r = await decideRequest({ tenantId: a.tenantId, actorId: a.userId }, kind, getRouterParam(event, 'id')!, p.data.decision, { comment: p.data.comment, isHr: can(a, 'development.manage') })
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : r.code === 'self' ? 403 : 409, `request.${r.code}`, r.code === 'self' ? 'Власну заявку не погоджують' : r.code === 'bad_step' ? 'Не ваш етап погодження' : 'Заявку не знайдено')
  return apiData(r)
})
