import { operatorInviteSchema } from '../../../../../shared/schemas/platformOperators'
import { inviteOperator } from '../../../../services/platformOperators'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { requirePlatform } from '../../../../utils/platformGuard'

/**
 * POST /platform/operators — пригласить оператора (только `owner`): e-mail, ПІБ, роль → письмо со
 * ссылкой задать пароль. Если платформенная почта не настроена или письмо не ушло, ссылка
 * возвращается владельцу (`inviteUrl`) — передать её он может сам.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'operators.manage')
  const p = operatorInviteSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте e-mail, ПІБ і роль', { issues: p.error.issues })
  const r = await inviteOperator(actor, p.data)
  if (!r.ok) return apiError(event, 409, 'operator.email_taken', 'Оператор із таким e-mail уже є — знайдіть його в списку')
  return apiData(r)
})
