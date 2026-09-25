import { personListQuerySchema } from '../../../../shared/schemas/people'
import { hasRatingCondition } from '../../../../shared/domain/engagementIndex'
import { areaOf, requireScope } from '../../../services/access'
import { listPeople } from '../../../services/people'
import { apiError } from '../../../utils/apiResponse'

/**
 * Список людей (docs/16 §5.1). Колонка «%» — індекс залученості (docs/v2/38 §5.2), не баллы
 * рейтинга: цифры отдаются только в области `person.rating.view_others` смотрящего; фильтр и
 * сортировка по индексу без этого скоупа — `403`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const parsed = personListQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Невірні параметри', { issues: parsed.error.issues })
  }
  const ratingArea = await areaOf(access, 'person.rating.view_others')
  if (ratingArea === 'none' && (parsed.data.sort === 'rating' || hasRatingCondition(parsed.data))) {
    return apiError(event, 403, 'forbidden', 'Фільтр і сортування за індексом залученості — лише з правом бачити чужий індекс')
  }
  const result = await listPeople(
    { tenantId: access.tenantId, actorId: access.userId },
    parsed.data,
    { ratingArea },
  )
  return { data: result.items, meta: { cursor: result.cursor, limit: parsed.data.limit, counts: result.counts } }
})
