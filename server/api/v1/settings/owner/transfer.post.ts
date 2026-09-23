import { ownerTransferSchema } from '../../../../../shared/schemas/settings'
import { requireScope } from '../../../../services/access'
import { transferOwnership } from '../../../../services/owner'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { ownerError } from './_errors'

/**
 * POST /settings/owner/transfer — «Передати володіння» (docs/01 §1.9.4).
 * Скоуп `tenant.transfer` є тільки в ролі `owner`, і сервіс додатково перевіряє, що передає
 * саме чинний власник: своя роль тенанта скоуп отримати не може (набір `owner` не редагується),
 * але покладатися на це одне — забагато.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'tenant.transfer')
  const p = ownerTransferSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть людину', { issues: p.error.issues })
  const r = await transferOwnership({ tenantId: a.tenantId, actorId: a.userId }, p.data.userId)
  if (!r.ok) return ownerError(event, r.code)
  return apiData(r.owner)
})
