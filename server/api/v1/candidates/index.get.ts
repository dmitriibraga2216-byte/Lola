import { candidateListSchema } from '../../../../shared/schemas/candidates'
import { requireScope } from '../../../services/access'
import { countActive, listCandidates, viewerOf } from '../../../services/candidates'
import { effectiveLimit } from '../../../services/tenantLimits'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /candidates — реестр кандидатов (docs/v2/28 §5.1, §10).
 *
 * `meta.limitLeft` — счётчик «Кандидатів: N із M» в шапке экрана (§5.1): число берётся
 * одной функцией эффективного лимита (docs/v2/44 В-5), а не считается здесь заново.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.view')
  const p = candidateListSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  const viewer = viewerOf(a)
  const items = await listCandidates(viewer, p.data)
  const current = await countActive(viewer)
  const limit = await effectiveLimit(a.tenantId, 'candidates_active')
  return apiData({ items, meta: { total: items.length, current, limit, limitLeft: limit === null ? null : Math.max(0, limit - current) } })
})
