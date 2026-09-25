import { resourcePassTickSchema } from '../../../../../../shared/schemas/resources'
import { requireScope } from '../../../../../services/access'
import { tickResourcePass } from '../../../../../services/resourcePass'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/** Тик прохождения ресурса (docs/11 §7.4): факты — клиент, сколько засчитать — сервер. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = resourcePassTickSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний тік')
  const r = await tickResourcePass({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Матеріал не відкрито — відкрийте його ще раз')
  return apiData(r)
})
