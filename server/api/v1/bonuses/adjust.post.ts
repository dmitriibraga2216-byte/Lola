import { bonusAdjustSchema } from '../../../../shared/schemas/gamification'
import { requireScope } from '../../../services/access'
import { adjustBonuses } from '../../../services/bonuses'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /bonuses/adjust (docs/04 §4.13) — «Нарахувати вручну»: сума зі знаком і обовʼязкова причина. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'bonus.grant')
  const p = bonusAdjustSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть людину, ненульову суму і причину від 3 символів', { issues: p.error.issues })
  const r = await adjustBonuses({ tenantId: a.tenantId, actorId: a.userId }, a, p.data)
  if (!r.ok) {
    switch (r.code) {
      case 'forbidden': return apiError(event, 403, 'forbidden', 'Ця людина не з вашої точки — бонуси їй нараховує її керівник')
      case 'not_found': return apiError(event, 404, 'not_found', 'Співробітника не знайдено')
      case 'self': return apiError(event, 409, 'bonus.self_grant', 'Собі бонуси не нараховують — попросіть колегу')
      case 'insufficient': return apiError(event, 409, 'bonus.insufficient', 'Списати більше, ніж є на балансі, не можна', r.details)
    }
  }
  return apiData({ balance: r.balance })
})
