import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertChecklist } from '../../../services/checklists'
import { apiData, apiError } from '../../../utils/apiResponse'
export const checklistSchema = z.object({
  id: z.string().uuid().optional(), title: z.string().min(3).max(200), kind: z.enum(['observation', 'audit', 'mystery']).default('observation'),
  items: z.array(z.object({ id: z.string().min(1), group: z.string().max(80).optional(), text: z.string().min(1).max(300), scaleId: z.string().uuid(), weight: z.number().min(0.1).max(100).default(1), isCritical: z.boolean().optional(), requiresPhoto: z.boolean().optional(), hint: z.string().max(300).optional() })).min(1, 'Додайте хоча б один пункт').max(200),
  scoring: z.enum(['percent', 'points', 'pass_fail']).default('percent'), passScore: z.number().min(1).max(100).default(80), criticalFailRule: z.enum(['any_critical_fails_all', 'none']).default('any_critical_fails_all'),
  whoCanRun: z.object({ roles: z.array(z.string()).min(1) }).default({ roles: ['mentor', 'manager', 'admin'] }), subjectKind: z.enum(['location', 'user', 'shift']).default('location'),
  frequency: z.object({ timesPerWeek: z.number().int().min(1).max(50) }).nullable().optional(), requireSignature: z.boolean().optional(), isActive: z.boolean().optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.manage')
  const p = checklistSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте чек-лист', { issues: p.error.issues })
  const r = await upsertChecklist({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Чек-лист не знайдено')
  return apiData(r)
})
