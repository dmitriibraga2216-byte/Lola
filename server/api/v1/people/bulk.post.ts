import { bulkSchema } from '../../../../shared/schemas/people'
import { areaOf, requireScope } from '../../../services/access'
import { BULK_FILTER_MAX, bulkPeople } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Масові дії зі списку (docs/16 §5.1): над позначеними або над усіма за фільтром. Індекс
 * залученості не може бути єдиною умовою архівування (docs/v2/38 §7.3, критерій §13 к. 3).
 */
export default defineEventHandler(async (event) => {
  const parsed = bulkSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте параметри дії', { issues: parsed.error.issues })
  const scope = parsed.data.action === 'archive' ? 'people.deactivate' : parsed.data.action === 'assign_role' ? 'role.assign' : parsed.data.action === 'invite' ? 'people.invite' : 'people.edit'
  const access = await requireScope(event, scope)
  const r = await bulkPeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data, { ratingArea: await areaOf(access, 'person.rating.view_others') })
  if (r.ok) return apiData({ done: r.done, errors: r.errors })
  switch (r.code) {
    case 'rating_only_filter_forbidden':
      return apiError(event, 422, 'rating_only_filter_forbidden', 'Індекс залученості не може бути єдиною умовою масового архівування чи блокування. Додайте ще одну умову (точка, посада, мітка…) або позначте людей вручну')
    case 'forbidden':
      return apiError(event, 403, 'forbidden', 'Фільтр за індексом залученості — лише з правом бачити чужий індекс')
    case 'too_many':
      return apiError(event, 422, 'validation_failed', `За фільтром більше ${BULK_FILTER_MAX} людей — звузьте фільтр`, { max: BULK_FILTER_MAX })
  }
})
