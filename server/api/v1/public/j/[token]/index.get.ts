import { publicVacancy } from '../../../../../services/publicApply'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * GET /api/v1/public/j/:token — публичная страница вакансии (docs/v2/29 §5.4, §10;
 * решение docs/v2/44 В-9).
 *
 * Правило контура (В-9 п. 2), выполняемое здесь целиком: тенант выводится из токена,
 * работа идёт внутри `withTenant()`, стоит `hitRateLimit`, несуществующий токен отвечает
 * `404` с выровненным временем. Обработчик тонкий — он не знает про тенанта вовсе.
 */
export default defineEventHandler(async (event) => {
  const r = await publicVacancy(getRouterParam(event, 'token')!, {
    ip: clientIp(event),
    userAgent: getHeader(event, 'user-agent'),
  })
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'rate_limited') {
    setResponseHeader(event, 'Retry-After', 600)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  // Чужой, несуществующий, закрытый и архивный токены неразличимы снаружи (§7.2, правило 15).
  if (r.code === 'gone') return apiError(event, 410, 'vacancy.paused', 'Набір за цією вакансією призупинено')
  return apiError(event, 404, 'vacancy.not_found', 'Посилання не знайдено')
})
