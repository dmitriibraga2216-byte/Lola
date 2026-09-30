import { publicSummaryPdf } from '../../../../../services/candidateSummaries'
import { apiError } from '../../../../../utils/apiResponse'
import { clientIp } from '../../../../../utils/authCookies'

/**
 * GET /api/v1/public/candidate-summaries/:token/pdf — PDF Підсумку кандидату по ссылке, без входа
 * (`docs/v2/30` §3.5, §10; `44` Р-AI2.9). Правило контура — в сервисе, тем же путём, что у страницы
 * (`publicSummary`): тенант из токена функцией `SECURITY DEFINER`, `withTenant()`, `hitRateLimit` (общий
 * потолок просмотров документа), неизвестный токен — `404` с выровненным временем. Ответ — `302` на
 * подписанную ссылку файла отправленной версии.
 */
export default defineEventHandler(async (event) => {
  const r = await publicSummaryPdf(getRouterParam(event, 'token')!, { ip: clientIp(event), userAgent: getHeader(event, 'user-agent') })
  if (r.ok) return sendRedirect(event, r.url, 302)
  if (r.code === 'rate_limited') {
    setResponseHeader(event, 'Retry-After', 600)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  if (r.code === 'expired') return apiError(event, 410, 'summary.share_expired', 'Термін дії посилання минув. Зверніться до рекрутера, щоб отримати нове')
  if (r.code === 'revoked') return apiError(event, 410, 'summary.revoked', 'Доступ до документа відкликано')
  if (r.code === 'unavailable') return apiError(event, 503, 'summary.pdf_unavailable', 'PDF тимчасово недоступний. Документ можна переглянути на сторінці за посиланням')
  return apiError(event, 404, 'summary.not_found', 'Посилання не знайдено')
})
