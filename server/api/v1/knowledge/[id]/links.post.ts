import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { linkArticle } from '../../../../services/knowledge'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ targetType: z.enum(['lesson', 'position']), targetId: z.string().uuid() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть ціль')
  return apiData(await linkArticle({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.targetType, p.data.targetId))
})
