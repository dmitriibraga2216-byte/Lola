import { requireScope } from '../../../../../services/access'
import { claim } from '../../../../../services/workshops'
import { apiData, apiError } from '../../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'review.grade')
  const r = await claim({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!)
  if (!r.ok) {
    if (r.code === 'already_claimed') return apiError(event, 409, 'already_claimed', 'Роботу вже взяв інший наставник')
    if (r.code === 'self_review') return apiError(event, 403, 'review.self', 'Не можна перевіряти власну роботу')
    // docs/v2/37 §7.1: назначенную или делегированную другому работу не берут в обход передачи
    if (r.code === 'assigned_to_other') return apiError(event, 409, 'review.assigned_to_other', 'Роботу призначено іншому перевіряючому. Попросіть його передати її вам або зверніться до керівника')
    // docs/v2/34 §7.5 п. 2: запис ще на пристрої співробітника — перевіряти поки нічого
    if (r.code === 'pending_upload') return apiError(event, 409, 'pending_upload', 'Файл роботи ще не вивантажено: сховище компанії заповнене. Робота стане доступна, щойно файл надійде')
    return apiError(event, 404, 'not_found', 'Роботу не знайдено')
  }
  return apiData(r)
})
