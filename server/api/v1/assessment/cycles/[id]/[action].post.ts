import { requireScope } from '../../../../../services/access'
import { cancelCycle, finishCycle, remindCycle, startCycle, toCalibration } from '../../../../../services/assessment'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** POST /assessment/cycles/:id/{start|finish|remind|calibrate|cancel} (docs/20 §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.run')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const id = getRouterParam(event, 'id')!
  switch (getRouterParam(event, 'action')) {
    case 'start': {
      const r = await startCycle(ctx, id)
      if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, r.code, r.code === 'no_subjects' ? 'Аудиторія порожня' : r.code === 'bad_status' ? 'Цикл уже запущено' : 'Цикл не знайдено')
      return apiData(r)
    }
    case 'finish': {
      const r = await finishCycle(ctx, id)
      if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 409, r.code, 'Цикл не активний')
      return apiData(r)
    }
    case 'remind':
      return apiData({ reminded: await remindCycle(ctx, id) })
    case 'calibrate':
      if (!await toCalibration(ctx, id)) return apiError(event, 409, 'bad_status', 'Калібрування не увімкнено або цикл не активний')
      return apiData({ ok: true })
    case 'cancel':
      if (!await cancelCycle(ctx, id)) return apiError(event, 409, 'bad_status', 'Цикл не можна скасувати')
      return apiData({ ok: true })
    default:
      return apiError(event, 404, 'not_found', 'Невідома дія')
  }
})
