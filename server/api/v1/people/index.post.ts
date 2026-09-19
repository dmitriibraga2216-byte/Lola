import { personCreateSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { addPlacement, createPerson } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.invite')
  const parsed = personCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const { checkPlanLimit } = await import('../../../services/platform')
  const limit = await checkPlanLimit(access.tenantId, 'users').catch(() => ({ ok: true, limit: null, current: 0 }))
  if (!limit.ok) return apiError(event, 422, 'plan.limit', `Ліміт тарифу: ${limit.limit} користувачів`, { limit: limit.limit, current: limit.current })
  try {
    const ctx = { tenantId: access.tenantId, actorId: access.userId }
    const { placement, ...data } = parsed.data
    const person = await createPerson(ctx, data)
    if (placement) await addPlacement(ctx, person.id, { ...placement, cityId: data.cityId ?? null, isPrimary: true })
    return apiData(person)
  }
  catch (err) {
    if (String(err).includes('users_tenant_id_phone_unique')) {
      return apiError(event, 409, 'conflict', 'Такий номер уже є в системі')
    }
    if (String(err).includes('external_id')) return apiError(event, 409, 'conflict', 'Такий зовнішній номер уже використовується')
    if (String(err).includes('email')) return apiError(event, 409, 'conflict', 'Така пошта вже використовується')
    throw err
  }
})
