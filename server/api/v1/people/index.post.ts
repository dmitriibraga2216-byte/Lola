import { personCreateSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { addPlacement, createPerson } from '../../../services/people'
import { LimitCheckFailedError, LimitExceededError } from '../../../services/tenantLimits'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /people. Место сотрудника проверяет сам `createPerson()` — в своей транзакции, до вставки
 * (docs/v2/35 §7.4): мест нет — `409 limit_exceeded`, проверка не состоялась — `503
 * limit.check_failed`, и человек в обоих случаях **не создаётся**. Прежняя проверка здесь, перед
 * сервисом, при сбое считала «можно» и заводила человека сверх лимита.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.invite')
  const parsed = personCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  try {
    const ctx = { tenantId: access.tenantId, actorId: access.userId }
    const { placement, ...data } = parsed.data
    const person = await createPerson(ctx, data)
    if (placement) await addPlacement(ctx, person.id, { ...placement, cityId: data.cityId ?? null, isPrimary: true })
    return apiData(person)
  }
  catch (err) {
    // Отказ по местам уходит как есть (`server/error.ts`): его текст не про телефон и пошту
    if (err instanceof LimitExceededError || err instanceof LimitCheckFailedError) throw err
    if (String(err).includes('users_tenant_id_phone_unique')) {
      return apiError(event, 409, 'conflict', 'Такий номер уже є в системі')
    }
    if (String(err).includes('external_id')) return apiError(event, 409, 'conflict', 'Такий зовнішній номер уже використовується')
    if (String(err).includes('email')) return apiError(event, 409, 'conflict', 'Така пошта вже використовується')
    throw err
  }
})
