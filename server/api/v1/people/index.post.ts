import { personCreateSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { createPerson } from '../../../services/people'
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
    const person = await createPerson(
      { tenantId: access.tenantId, actorId: access.userId },
      parsed.data,
    )
    return apiData(person)
  }
  catch (err) {
    if (String(err).includes('users_tenant_id_phone_unique')) {
      return apiError(event, 409, 'conflict', 'Людина з таким телефоном вже існує')
    }
    throw err
  }
})
