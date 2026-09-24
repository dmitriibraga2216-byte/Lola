import { z } from 'zod'
import { publicSubmit } from '../../../../../services/mystery'
import { hitRateLimit } from '../../../../../services/rateLimit'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * Отправка прогона тайного покупателя. Частотное ограничение — решение docs/v2/44 В-9 п. 3
 * (правило публичного контура, пункт «в»): отправок с одного адреса меньше, чем просмотров,
 * потому что каждая создаёт строку `checklist_runs` в чужом тенанте.
 */
const SUBMIT_LIMIT = 10
const SUBMIT_WINDOW_SEC = 3600

const schema = z.object({
  answers: z.array(z.object({ itemId: z.string(), value: z.number().nullable(), comment: z.string().max(2000).nullable().optional(), isNa: z.boolean().optional(), photoMediaIds: z.array(z.string().uuid()).max(10).optional() })).max(200),
  startedAt: z.string().datetime({ offset: true }).optional(),
})
export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`mystery:submit:${clientIp(event)}`, SUBMIT_LIMIT, SUBMIT_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', SUBMIT_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато спроб. Спробуйте пізніше')
  }
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відповіді')
  const r = await publicSubmit(getRouterParam(event, 'token')!, { ...p.data, device: getHeader(event, 'user-agent')?.slice(0, 200) })
  if (!r.ok) {
    if (r.code === 'incomplete') return apiError(event, 422, 'mystery.incomplete', 'Відмітьте всі пункти', { itemIds: r.itemIds })
    return apiError(event, r.code === 'not_found' ? 404 : 410, `mystery.${r.code}`, r.code === 'used' ? 'Це посилання вже використано' : 'Посилання застаріло')
  }
  return apiData(r)
})
