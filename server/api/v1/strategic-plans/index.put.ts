import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertStrategicPlan } from '../../../services/developmentExtra'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({
  id: z.string().uuid().optional(), title: z.string().min(3).max(200), periodFrom: z.string().date(), periodTo: z.string().date(), orgUnitId: z.string().uuid().nullable().optional(),
  goals: z.array(z.object({ title: z.string().min(1).max(300), metric: z.string().max(200).optional(), target: z.string().max(100).optional() })).max(50).optional(),
  budget: z.number().min(0).nullable().optional(), kpi: z.array(z.object({ name: z.string().min(1).max(200), target: z.string().max(100).optional(), unit: z.string().max(30).optional() })).max(50).optional(),
  status: z.enum(['draft', 'active', 'closed']).optional(),
}).refine(p => p.periodTo >= p.periodFrom, { message: 'Кінець періоду раніше початку', path: ['periodTo'] })
/** Стратегічні плани навчання (docs/19 §3.8). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await upsertStrategicPlan({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'План не знайдено')
  return apiData(r)
})
