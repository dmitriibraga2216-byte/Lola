import { retentionDryRunSchema } from '../../../../../shared/schemas/storage'
import { requireScope } from '../../../../services/access'
import { retentionDryRun } from '../../../../services/storagePolicies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * `POST /storage/retention-policies/dry-run` (docs/v2/34 §5.2, §10; метод уточнён `41` §8.5):
 * сколько файлов и байт политика удалила бы сегодня — «Буде звільнено приблизно {size}».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'storage.policy')
  const p = retentionDryRunSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Не вдалося порахувати обсяг')
  return apiData(await retentionDryRun({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
