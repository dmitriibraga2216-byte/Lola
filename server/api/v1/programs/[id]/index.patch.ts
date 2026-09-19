import { z } from 'zod'
import { requireScope, can } from '../../../../services/access'
import { updateProgram } from '../../../../services/programs'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ title: z.string().min(3).max(200).optional(), description: z.string().max(2000).nullable().optional(), mode: z.enum(['linear', 'graph']).optional(), tags: z.array(z.string()).max(20).optional(), coverKey: z.string().nullable().optional(), assignmentMode: z.array(z.enum(['manual', 'catalog_free', 'catalog_request', 'automation'])).min(1, 'Оберіть, як програма потрапляє до людей').optional(), automationRuleId: z.string().uuid().nullable().optional(), noAssignAfterFinish: z.boolean().optional(), countPriorResults: z.boolean().optional(), validityMonths: z.number().int().min(1).max(120).nullable().optional(), dueDays: z.number().int().min(1).max(730).nullable().optional(), status: z.enum(['draft', 'archived']).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте програму', { issues: p.error.issues })
  if (p.data.automationRuleId !== undefined && !can(a, 'program.link_rule')) return apiError(event, 403, 'forbidden', 'Привʼязувати правило може лише адміністратор')
  const r = await updateProgram({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Програму не знайдено')
  return apiData(r)
})
