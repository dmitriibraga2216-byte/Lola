import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { runRuleManually } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** «Виконати вручну» — разовый запуск по всем подходящим; dryRun — «Тестовий запуск» без записи (docs/15 §3.6, §7.9). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = z.object({ dryRun: z.boolean().default(false) }).safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірні параметри')
  const r = await runRuleManually({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
