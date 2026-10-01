import { mergeSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { mergePeople } from '../../../services/people'
import { assertPersonAccess } from '../../../services/personGuard'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Обʼєднання дублів (docs/16 §7.7). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.deactivate')
  const parsed = mergeSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Оберіть дві різні картки', { issues: parsed.error.issues })
  // Дубль архівується, а його навчання переходить основній картці — обидві в області й не ширші за права (security-sweep-1)
  await assertPersonAccess(access, 'people.deactivate', parsed.data.duplicateId, { sensitive: true })
  await assertPersonAccess(access, 'people.deactivate', parsed.data.primaryId, { sensitive: true })
  const r = await mergePeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.primaryId, parsed.data.duplicateId)
  if (!r.ok) {
    if (r.code === 'last_owner') return apiError(event, 409, 'last_owner', 'Це власник простору — спочатку передайте володіння іншій людині')
    return apiError(event, r.code === 'same' ? 400 : 404, r.code, r.code === 'same' ? 'Це одна й та сама картка' : 'Людину не знайдено')
  }
  return apiData(r)
})
