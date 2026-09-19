import { mergeSchema } from '../../../../shared/schemas/people'
import { requireScope } from '../../../services/access'
import { mergePeople } from '../../../services/people'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Обʼєднання дублів (docs/16 §7.7). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.deactivate')
  const parsed = mergeSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Оберіть дві різні картки', { issues: parsed.error.issues })
  const r = await mergePeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data.primaryId, parsed.data.duplicateId)
  if (!r.ok) return apiError(event, r.code === 'same' ? 400 : 404, r.code, r.code === 'same' ? 'Це одна й та сама картка' : 'Людину не знайдено')
  return apiData(r)
})
