import { placementSchema } from '../../../../../shared/schemas/people'
import { areaCovers, areaOf, hasTenantGrant, requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { addPlacement } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.edit')
  await assertPersonAccess(access, 'people.edit', getRouterParam(event, 'id')!, { sensitive: true })
  const parsed = placementSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  // Основне розміщення тягне ролі за правилом «посада → роль»: собі його ставить лише той, хто й так
  // роздає ролі; чужу точку поза своєю областю — ні (security-sweep-1)
  if (getRouterParam(event, 'id') === access.userId && !hasTenantGrant(access, 'role.assign')) {
    return apiError(event, 403, 'forbidden', 'Власне розміщення змінює адміністратор')
  }
  if (!areaCovers(await areaOf(access, 'people.edit'), parsed.data.locationId)) {
    return apiError(event, 403, 'forbidden', 'Точка поза вашою областю. Оберіть точку, якою ви керуєте')
  }
  const placement = await addPlacement(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    parsed.data,
  )
  return apiData(placement)
})
