import { offboardingStartSchema } from '../../../../shared/schemas/offboarding'
import { requireScope } from '../../../services/access'
import { startOffboarding } from '../../../services/offboarding'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /offboarding — запуск офбординга (docs/v2/33 §4.2, форма §6.2, §10).
 *
 * `409 offboarding.active_exists` — у человека уже идёт увольнение (один активный случай,
 * §3.6). `409 people.last_admin` — последнего администратора тенанта уволить нельзя
 * (docs/16 §7.6): иначе пространство останется без владельца.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'offboarding.start')
  const p = offboardingStartSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані звільнення', { issues: p.error.issues })
  const r = await startOffboarding({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Людину не знайдено')
  if (r === 'active_exists') return apiError(event, 409, 'offboarding.active_exists', 'Звільнення цієї людини вже розпочато')
  if (r === 'last_admin') return apiError(event, 409, 'people.last_admin', 'Це останній адміністратор простору — спершу призначте іншого')
  if (r === 'stage_missing') return apiError(event, 409, 'lifecycle.disabled', 'Етап «Офбординг» не налаштовано')
  return apiData(r)
})
