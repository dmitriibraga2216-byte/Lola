import { reviewQueueQuerySchema } from '../../../../shared/schemas/review'
import { can, requireScope } from '../../../services/access'
import { listReviewQueue, reviewQueueCounts, reviewQueueExportRows } from '../../../services/reviewQueue'
import { toXlsx } from '../../../services/reports'
import { toCsv } from '../../../services/reportExports'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Единая очередь проверки поверх `review_queue_items` (docs/v2/37 §10, решение docs/v2/44 В-15).
 *
 * До этого PR путь был алиасом `/review/answers` без фильтров и отдавал голый массив с жёстким
 * `limit 200`. Теперь это самостоятельный список: четыре таба, фильтры экрана `37` §5.1, `total`
 * и ключевой курсор. Три базовых пути остаются узкими фильтрами поверх своих источников —
 * у них есть то, чего у очереди нет (метки вопросов, «Поза програмами», «Поза курсами»).
 *
 * С PR-19 табы «Делеговані мені» и «Делеговані мною» наполнены (`review_delegations`), а ответ
 * несёт `counts` — счётчики всех табов для шапки экрана.
 *
 * `format=xlsx|csv` — выгрузка экрана «Черга перевірки» (`37` §9.1): те же таб и фильтры, все
 * страницы (до 5000 строк), колонки §9.1. Право — `report.export`, как у всех выгрузок (docs/22 §3).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.queue')
  const q = getQuery(event)
  const bool = (v: unknown) => v === true || v === 'true' || v === '1'
  const p = reviewQueueQuerySchema.safeParse({
    tab: q.tab ?? undefined,
    taskType: q.taskType || undefined,
    locationId: q.locationId || undefined,
    trackId: q.trackId || undefined,
    reviewerId: q.reviewerId || undefined,
    subjectKind: q.subjectKind || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    overdue: bool(q.overdue),
    cursor: q.cursor || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  })
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний фільтр черги')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  if (q.format === 'xlsx' || q.format === 'csv') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    const rows = await reviewQueueExportRows(ctx, p.data)
    if (q.format === 'csv') {
      setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
      setHeader(event, 'Content-Disposition', 'attachment; filename="lola-review-queue.csv"')
      return toCsv(rows)
    }
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', 'attachment; filename="lola-review-queue.xlsx"')
    return toXlsx('review-queue', rows)
  }
  // Счётчики табов (`37` §5.1: «Мої» — ждущие и взятые, просроченные коралловые) — одним ответом
  // со списком, чтобы экран не делал четыре запроса на каждое переключение таба.
  return apiData({ ...(await listReviewQueue(ctx, p.data)), counts: await reviewQueueCounts(ctx) })
})
