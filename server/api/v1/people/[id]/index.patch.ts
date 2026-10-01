import { personUpdateSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { assertPersonAccess } from '../../../../services/personGuard'
import { updatePerson } from '../../../../services/people'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const body = personUpdateSchema.safeParse(await readBody(event))
  if (!body.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: body.error.issues })
  }
  // Деактивация — отдельный скоуп (docs/01-roles.md §1.4)
  const scope = body.data.status === 'archived' || body.data.status === 'suspended'
    ? 'people.deactivate'
    : 'people.edit'
  const access = await requireScope(event, scope)
  // Вход, контакты и доступ чужого человека — только в своей области и не шире своих прав (personGuard)
  const d = body.data
  const sensitive = d.phone !== undefined || d.email !== undefined || d.status !== undefined || d.isBlocked !== undefined
  await assertPersonAccess(access, scope, getRouterParam(event, 'id')!, { sensitive })

  const person = await updatePerson(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
    body.data,
  )
  if (!person) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  // Останнього адміністратора не заблокувати й не архівувати (docs/16 §6.2)
  if ('lastOwner' in person) return apiError(event, 409, 'last_owner', 'Це власник простору — спочатку передайте володіння іншій людині')
  if ('lastAdmin' in person) return apiError(event, 409, 'last_admin', 'Це останній адміністратор — спочатку призначте іншого')
  return apiData(person)
})
