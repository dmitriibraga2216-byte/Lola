import { z } from 'zod'
import { phoneSchema } from '../../../../../shared/schemas/auth'
import { requirePlatform } from '../../../../utils/platformGuard'
import { createTenant } from '../../../../services/platform'
import { apiData, apiError } from '../../../../utils/apiResponse'
export const tenantCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'slug: a-z, 0-9, дефіс'), name: z.string().min(2).max(120),
  locale: z.enum(['uk', 'en', 'ru']).optional(), timezone: z.string().max(60).optional(), plan: z.string().optional(), trialDays: z.number().int().min(1).max(90).optional(),
  adminPhone: phoneSchema, adminName: z.string().min(2).max(200), locationName: z.string().max(120).optional(), positionName: z.string().max(120).optional(),
})
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'tenant.create')
  const p = tenantCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await createTenant(p.data, actor)
  if (!r.ok) return apiError(event, 409, `tenant.${r.code}`, r.code === 'slug_taken' ? 'Такий slug вже зайнятий' : 'Невідомий тариф')
  return apiData(r)
})
