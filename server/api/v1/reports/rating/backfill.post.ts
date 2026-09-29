import { requireScope } from '../../../../services/access'
import { auditEngagement } from '../../../../services/engagementIndex'
import { enqueueRatingBackfill } from '../../../../services/queue'
import { apiData } from '../../../../utils/apiResponse'

/**
 * POST /reports/rating/backfill — ретро-расчёт динамики индекса за 12 прошедших месяцев
 * (docs/v2/38 §7.2, Р-38.7): задача `rating.backfill` в очереди, существующие снимки не
 * перезаписываются. Запускает администратор пространства (`settings.tenant`), след — `audit_log`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.tenant')
  await enqueueRatingBackfill(a.tenantId)
  await auditEngagement({ tenantId: a.tenantId, actorId: a.userId }, 'person_rating.backfill', { months: 12 })
  setResponseStatus(event, 202)
  return apiData({ queued: true })
})
