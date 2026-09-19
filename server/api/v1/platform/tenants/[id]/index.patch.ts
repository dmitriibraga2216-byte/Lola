import { z } from 'zod'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { updateTenant } from '../../../../../services/platform'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ status: z.enum(['active', 'suspended', 'archived']).optional(), plan: z.string().optional(), trialEndsAt: z.string().datetime().nullable().optional(), name: z.string().min(2).max(120).optional(), settings: z.record(z.unknown()).optional() })
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event)
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля')
  const r = await updateTenant(getRouterParam(event, 'id')!, p.data, actor)
  if (!r) return apiError(event, 404, 'not_found', 'Тенант не знайдено')
  return apiData(r)
})
