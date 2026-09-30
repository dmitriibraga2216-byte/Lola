import { publicSubscribeSchema } from '../../../../../../shared/schemas/publicApply'
import { subscribeToVacancy } from '../../../../../services/vacancySubscribers'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * POST /api/v1/public/j/:token/subscribe — «Повідомити, коли відкриється» на странице 410
 * (docs/v2/29 §5.6, §10). Правило контура (`docs/27` §27.8.1): тенант из токена, `withTenant`,
 * `hitRateLimit`, неизвестный и закрытый токен — `404` с выровненным временем. Ответ `202`
 * одинаков для приостановленной и открытой вакансии.
 */
export default defineEventHandler(async (event) => {
  const p = publicSubscribeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation', 'Вкажіть коректну електронну пошту', { issues: p.error.issues })
  const r = await subscribeToVacancy(getRouterParam(event, 'token')!, p.data.email, {
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })
  if (r.ok) {
    setResponseStatus(event, 202)
    return apiData({ ok: true })
  }
  if (r.code === 'rate_limited') {
    setResponseHeader(event, 'Retry-After', 3600)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте пізніше')
  }
  return apiError(event, 404, 'vacancy.not_found', 'Посилання не знайдено')
})
