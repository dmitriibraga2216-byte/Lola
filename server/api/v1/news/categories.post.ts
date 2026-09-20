import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { createNewsCategory } from '../../../services/news'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'knowledge.manage')
  const p = z.object({ name: z.string().min(2).max(120) }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Назва категорії від 2 символів')
  return apiData(await createNewsCategory({ tenantId: a.tenantId, actorId: a.userId }, p.data.name))
})
