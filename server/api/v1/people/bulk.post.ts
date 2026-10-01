import { bulkSchema } from '../../../../shared/schemas/people'
import { areaCovers, areaOf, hasTenantGrant, requireScope } from '../../../services/access'
import { BULK_FILTER_MAX, bulkPeople } from '../../../services/people'
import { checkPersonAccess, checkRoleAssign } from '../../../services/personGuard'
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
  const input = parsed.data
  // Кожна людина — як в одиночній дії: своя область, не ширші права, роль не ширша за свою (security-sweep-1)
  const editArea = input.action === 'set_location' ? await areaOf(access, 'people.edit') : null
  const guard = async (id: string): Promise<boolean> => {
    const sensitive = input.action === 'archive' || input.action === 'invite' || input.action === 'set_location'
    if (!(await checkPersonAccess(access, scope, id, { sensitive })).ok) return false
    if (input.action === 'assign_role') return checkRoleAssign(access, id, { roleCode: input.roleCode!, scopeType: 'tenant' })
    if (input.action === 'set_location') return (id !== access.userId || hasTenantGrant(access, 'role.assign')) && areaCovers(editArea!, input.locationId)
    return true
  }
  const r = await bulkPeople({ tenantId: access.tenantId, actorId: access.userId }, input, { ratingArea: await areaOf(access, 'person.rating.view_others'), guard })
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
