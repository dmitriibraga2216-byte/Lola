import { publicForm } from '../../../../../services/mystery'
import { hitRateLimit } from '../../../../../services/rateLimit'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * Форма тайного покупателя по одноразовой ссылке — без входа (docs/20 §7.8, Б.2).
 *
 * Частотное ограничение добавлено решением docs/v2/44 В-9 п. 3: правило публичного контура
 * требует `hitRateLimit` у **каждой** ручки под `public/`, а перебор токенов тайного гостя
 * был ограничен только одноразовостью ссылки — долг, вскрытый сверкой фазы 0 и закрытый
 * здесь, а не перенесённый. Порог тот же, что у просмотра публичной вакансии (`29` §7.4):
 * 30 обращений с адреса за 10 минут, дальше `429` с `Retry-After`.
 */
const VIEW_LIMIT = 30
const VIEW_WINDOW_SEC = 600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`mystery:view:${clientIp(event)}`, VIEW_LIMIT, VIEW_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', VIEW_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  const r = await publicForm(getRouterParam(event, 'token')!)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 410, `mystery.${r.code}`, r.code === 'used' ? 'Це посилання вже використано' : r.code === 'expired' ? 'Посилання застаріло — попросіть нове' : 'Посилання не знайдено')
  return apiData(r.form)
})
