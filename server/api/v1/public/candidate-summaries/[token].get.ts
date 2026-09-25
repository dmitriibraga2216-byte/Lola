import { publicSummary } from '../../../../services/candidateSummaries'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { clientIp } from '../../../../utils/authCookies'

/**
 * GET /api/v1/public/candidate-summaries/:token — Підсумок кандидату по ссылке из письма, без входа
 * (`docs/v2/30` §10; `41` §8.3.2; решение `44` В-9).
 *
 * Правило контура выполнено в сервисе: тенант выводится из токена функцией `SECURITY DEFINER`,
 * работа идёт внутри `withTenant()`, стоит `hitRateLimit` (30 просмотров за 10 минут с адреса),
 * неизвестный токен — `404` с выровненным временем. Документ — без ПД третьих лиц и всегда со
 * строкой «Документ сформовано автоматично». Истёкшая ссылка — `410 summary.share_expired`,
 * отозванная — `410 summary.revoked`.
 */
export default defineEventHandler(async (event) => {
  const r = await publicSummary(getRouterParam(event, 'token')!, { ip: clientIp(event), userAgent: getHeader(event, 'user-agent') })
  if (r.ok) return apiData(r.summary)
  if (r.code === 'rate_limited') {
    setResponseHeader(event, 'Retry-After', 600)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  if (r.code === 'expired') return apiError(event, 410, 'summary.share_expired', 'Термін дії посилання минув. Зверніться до рекрутера, щоб отримати нове')
  if (r.code === 'revoked') return apiError(event, 410, 'summary.revoked', 'Доступ до документа відкликано')
  return apiError(event, 404, 'summary.not_found', 'Посилання не знайдено')
})
