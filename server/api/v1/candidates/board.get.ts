import { candidateBoardSchema } from '../../../../shared/schemas/candidates'
import { requireScope } from '../../../services/access'
import { countActive, viewerOf } from '../../../services/candidates'
import { board, boardColumn } from '../../../services/candidateFunnel'
import { effectiveLimit } from '../../../services/tenantLimits'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /candidates/board — канбан воронки (docs/v2/28 §5.2, §10).
 *
 * Без `statusId` — вся доска: по странице в каждой колонке и общее число карточек в ней.
 * С `statusId` и `cursor` — следующая страница одной колонки: ровно это зовёт «Показати ще»,
 * и доска целиком при этом не пересчитывается (критерий §13 к. 12 — 250 карточек в колонке
 * отдаются по 50).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.view')
  const p = candidateBoardSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри дошки', { issues: p.error.issues })
  const viewer = viewerOf(a)

  if (p.data.statusId) {
    const column = await boardColumn(viewer, p.data.statusId, p.data)
    // Чужая колонка (в том числе колонка чужого тенанта) — 404, существование не подтверждается.
    if (!column) return apiError(event, 404, 'not_found', 'Колонку воронки не знайдено')
    return apiData(column)
  }

  const columns = await board(viewer, p.data)
  const current = await countActive(viewer)
  const limit = await effectiveLimit(a.tenantId, 'candidates_active')
  return apiData({ columns, meta: { current, limit, limitLeft: limit === null ? null : Math.max(0, limit - current) } })
})
