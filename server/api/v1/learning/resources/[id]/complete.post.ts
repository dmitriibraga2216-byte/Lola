import { resourcePassRefSchema } from '../../../../../../shared/schemas/resources'
import { requireScope } from '../../../../../services/access'
import { completeResourcePass } from '../../../../../services/resourcePass'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Завершить ресурс как задание: сервер сам проверяет правило типа (Г-11.5) и, если оно выполнено,
 * зачитывает — узел траектории и элемент программы двигаются тем же хуком, что у курса и теста.
 * Не выполнено — 422 `resource.conditions_not_met` с причинами (`reasons` — текст, `missing` — коды).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = resourcePassRefSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Некоректне призначення')
  const r = await completeResourcePass({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Матеріал не відкрито — відкрийте його ще раз')
    return apiError(event, 422, 'resource.conditions_not_met', r.reasons[0] ?? 'Умови зарахування не виконані', { reasons: r.reasons, missing: r.missing })
  }
  return apiData(r)
})
