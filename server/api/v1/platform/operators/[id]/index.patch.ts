import { z } from 'zod'
import { operatorPatchSchema } from '../../../../../../shared/schemas/platformOperators'
import { patchOperator } from '../../../../../services/platformOperators'
import { apiData, apiError } from '../../../../../utils/apiResponse'
import { requirePlatform } from '../../../../../utils/platformGuard'

/** PATCH /platform/operators/:id — сменить роль или деактивировать (только `owner`, docs/25 §7 п. 7). */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'operators.manage')
  const id = getRouterParam(event, 'id')!
  if (!z.string().uuid().safeParse(id).success) return apiError(event, 404, 'not_found', 'Оператора не знайдено')
  const p = operatorPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте роль', { issues: p.error.issues })
  const r = await patchOperator(actor, id, p.data)
  if (r.ok) return apiData(r.operator)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Оператора не знайдено')
  if (r.code === 'self') return apiError(event, 409, 'operator.self', 'Свою роль і доступ змінює інший власник платформи')
  return apiError(event, 409, 'operator.last_owner', 'Це останній власник платформи. Спершу призначте власником іншого оператора')
})
