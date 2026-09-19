import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { finishRun } from '../../../../services/checklists'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { actionSchema, answerSchema } from './index.put'
const schema = z.object({ answers: z.array(answerSchema).max(200).optional(), actionPlan: z.array(actionSchema).max(50).optional(), finishedAt: z.string().datetime({ offset: true }).optional(), startedAt: z.string().datetime({ offset: true }).optional(), signatureMediaId: z.string().uuid().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.run')
  const p = schema.safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте дані прогону')
  const r = await finishRun({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    const msg: Record<string, string> = { not_found: 'Прогін не знайдено', incomplete: 'Відмітьте всі пункти', photo_required: 'Для цих пунктів потрібне фото', action_plan_required: 'Чек-лист не пройдено — додайте план дій: що виправити, хто відповідальний, до коли' }
    return apiError(event, r.code === 'not_found' ? 404 : 422, `checklist.${r.code}`, msg[r.code]!, { itemIds: r.itemIds })
  }
  return apiData(r)
})
