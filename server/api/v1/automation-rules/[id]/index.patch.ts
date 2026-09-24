import { ruleSchema } from '../../../../../shared/schemas/assignments'
import { requireScope } from '../../../../services/access'
import { RuleBoundToPositionError, updateRule } from '../../../../services/automation'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = ruleSchema.partial().safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте правило')
  const r = await updateRule({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
    .catch((e: unknown) => { if (e instanceof RuleBoundToPositionError) return e; throw e })
  if (r instanceof RuleBoundToPositionError) return apiError(event, 409, r.data.code, r.data.message)
  if (!r) return apiError(event, 404, 'not_found', 'Правило не знайдено')
  return apiData(r)
})
