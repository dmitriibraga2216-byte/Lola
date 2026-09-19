import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { saveRun } from '../../../../services/checklists'
import { apiData, apiError } from '../../../../utils/apiResponse'
export const answerSchema = z.object({ itemId: z.string().min(1), value: z.number().nullable(), comment: z.string().max(1000).nullable().optional(), photoMediaIds: z.array(z.string().uuid()).max(10).optional(), isNa: z.boolean().optional() })
export const actionSchema = z.object({ id: z.string().min(1), text: z.string().min(1).max(500), responsibleId: z.string().uuid(), dueAt: z.string().date(), status: z.enum(['open', 'done', 'overdue']).default('open') })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = z.object({ answers: z.array(answerSchema).max(200), startedAt: z.string().datetime({ offset: true }).optional(), actionPlan: z.array(actionSchema).max(50).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відповіді')
  const r = await saveRun({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 409, 'bad_status', 'Прогін уже завершено')
  return apiData(r)
})
