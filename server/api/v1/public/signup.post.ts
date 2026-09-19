import { z } from 'zod'
import { phoneSchema } from '../../../../shared/schemas/auth'
import { createTenant } from '../../../services/platform'
import { hitRateLimit } from '../../../services/rateLimit'
import { apiData, apiError } from '../../../utils/apiResponse'
import { clientIp } from '../../../utils/authCookies'

/** Самостоятельная регистрация с триалом (docs/07 этап 6). Включается SIGNUP_ENABLED=1. */
const schema = z.object({ company: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]{3,40}$/), adminName: z.string().min(2).max(200), adminPhone: phoneSchema })
export default defineEventHandler(async (event) => {
  if (process.env.SIGNUP_ENABLED !== '1') return apiError(event, 403, 'forbidden', 'Самореєстрацію вимкнено')
  if (!await hitRateLimit(`signup:${clientIp(event)}`, 3, 3600)) return apiError(event, 429, 'rate_limited', 'Забагато реєстрацій з цієї адреси')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await createTenant({ slug: p.data.slug, name: p.data.company, adminPhone: p.data.adminPhone, adminName: p.data.adminName, plan: 'trial', trialDays: 14 }, { adminId: 'signup', email: 'signup', fullName: 'signup' })
  if (!r.ok) return apiError(event, 409, `tenant.${r.code}`, 'Такий slug вже зайнятий')
  return apiData({ ok: true, slug: p.data.slug })
})
