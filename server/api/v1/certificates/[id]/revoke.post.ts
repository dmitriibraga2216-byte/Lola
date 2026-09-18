import { revokeSchema } from '../../../../../shared/schemas/quizzes'
import { requireScope } from '../../../../services/access'
import { revokeCertificate } from '../../../../services/certificates'
import { apiData, apiError } from '../../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.deactivate')
  const p = revokeSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть причину (10–500 символів)')
  const r = await revokeCertificate({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data.reason)
  if (!r) return apiError(event, 404, 'not_found', 'Сертифікат не знайдено або вже відкликано')
  return apiData(r)
})
