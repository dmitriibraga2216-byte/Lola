import { z } from 'zod'
import { requireScope, developmentPlanScope } from '../../../../../services/access'
import { getPlanCard, updatePlan } from '../../../../../services/development'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Редагування плану (докс/28 «Spec 19 (продовження)»: раніше PATCH не існувало зовсім). Статус — тільки через `/transition`. */
const schema = z.object({ summary: z.string().max(2000).nullable().optional(), periodFrom: z.string().date().optional(), periodTo: z.string().date().optional() })
  .refine(p => !p.periodFrom || !p.periodTo || p.periodTo > p.periodFrom, { message: 'Кінець періоду має бути пізніше початку', path: ['periodTo'] })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.team')
  const id = getRouterParam(event, 'id')!
  const existing = await getPlanCard({ tenantId: a.tenantId, actorId: a.userId }, id)
  if (!existing) return apiError(event, 404, 'not_found', 'План не знайдено')
  const scope = await developmentPlanScope(a)
  if (scope !== null && (!existing.locationId || !scope.includes(existing.locationId))) return apiError(event, 403, 'forbidden', 'Немає доступу')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await updatePlan({ tenantId: a.tenantId, actorId: a.userId }, id, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'План не знайдено')
  return apiData(r)
})
