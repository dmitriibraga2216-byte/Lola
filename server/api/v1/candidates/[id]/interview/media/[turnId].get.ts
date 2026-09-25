import { requireScope } from '../../../../../../services/access'
import { viewerOf } from '../../../../../../services/candidates'
import { listenTurn } from '../../../../../../services/interview/recruiter'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/**
 * GET /candidates/:id/interview/media/:turnId — ссылка на прослушивание реплики (`docs/v2/30`
 * §7.8, §10). Только `interview.listen`: без права — `403 forbidden` ещё до сервиса, и строки
 * журнала о прослушивании нет (`30` §13 к. 12). Ссылка — 15 минут, `inline`; каждое
 * прослушивание — `audit_log` `interview.media.listen`. Удалённое аудио — `410 media.purged`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.listen')
  const r = await listenTurn(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'turnId')!)
  if (r.ok) return apiData({ url: r.url, expiresAt: r.expiresAt })
  if (r.code === 'purged') return apiError(event, 410, 'media.purged', 'Аудіозапис уже видалено за строком зберігання. Розшифровка збережена', { deletedAt: r.deletedAt })
  return apiError(event, 404, 'not_found', 'Запис не знайдено')
})
