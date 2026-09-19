import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { setSecret, SECRET_KEYS, type Provider } from '../../../../../services/secrets'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({ values: z.record(z.string().min(1).max(2000)), accountLabel: z.string().max(200).optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const provider = getRouterParam(event, 'provider') as Provider
  if (!(provider in SECRET_KEYS)) return apiError(event, 404, 'not_found', 'Невідома інтеграція')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення')
  const allowed = new Set(Object.values(SECRET_KEYS[provider]) as string[])
  for (const [key, value] of Object.entries(p.data.values)) {
    if (!allowed.has(key)) return apiError(event, 400, 'validation_failed', `Невідомий ключ ${key}`)
    await setSecret({ tenantId: a.tenantId, actorId: a.userId }, provider, key, value, p.data.accountLabel)
  }
  return apiData({ ok: true })
})
