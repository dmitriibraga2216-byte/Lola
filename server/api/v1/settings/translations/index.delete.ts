import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { resetAllTranslations, resetTranslation } from '../../../../services/translations'
import { apiData, apiError } from '../../../../utils/apiResponse'
const q = z.object({ locale: z.enum(['uk', 'en', 'ru']), key: z.string().max(200).optional() })
/** DELETE /settings/translations?locale=&key= — «Повернути стандартний» для ключа; без key — для всего набора. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  const p = q.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть мову')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (p.data.key) {
    const ok = await resetTranslation(ctx, p.data.locale, p.data.key)
    return apiData({ reset: ok ? 1 : 0 })
  }
  return apiData({ reset: await resetAllTranslations(ctx, p.data.locale) })
})
