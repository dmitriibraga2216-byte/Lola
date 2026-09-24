import { applicationListSchema } from '../../../../../shared/schemas/publicApply'
import { requireScope } from '../../../../services/access'
import { listApplications } from '../../../../services/publicApply'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /vacancies/:id/applications — отклики вакансии (docs/v2/29 §5.5, §10).
 * Вкладка «На модерації» — это `?state=pending_review` (§7.7).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.view')
  const p = applicationListSchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри', { issues: p.error.issues })
  const items = await listApplications({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!items) return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiData({ items, meta: { total: items.length } })
})
