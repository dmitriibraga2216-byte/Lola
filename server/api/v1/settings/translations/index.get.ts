import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { listTranslations } from '../../../../services/translations'
import { apiData, apiError } from '../../../../utils/apiResponse'
const q = z.object({ locale: z.enum(['uk', 'en']).default('uk'), q: z.string().max(200).optional(), changedOnly: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).optional(), perPage: z.coerce.number().int().min(1).max(500).optional() })
/** GET /settings/translations (docs/24 §3.6): ключ · стандартный · свой · кто · когда. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = q.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри')
  return apiData(await listTranslations({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
