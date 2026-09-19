import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { runRules } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { withTenant } from '../../../../utils/withTenant'
import { automationRules } from '../../../../db/schema'
import { eq } from 'drizzle-orm'

/** Сухой прогон (docs/15 §7.9): что произошло бы для человека, без записи. */
const body = z.object({ userId: z.string().uuid(), payload: z.record(z.unknown()).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = body.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть людину')
  const id = getRouterParam(event, 'id')!
  const [rule] = await withTenant(a.tenantId, a.userId, tx => tx.select().from(automationRules).where(eq(automationRules.id, id)))
  if (!rule) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(await runRules(a.tenantId, rule.trigger as never, p.data.userId, p.data.payload ?? {}, { dryRun: true, ruleId: id }))
})
