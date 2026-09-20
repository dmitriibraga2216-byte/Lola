import { requireScope } from '../../../services/access'
import { upsertChecklist } from '../../../services/checklists'
import { checklistSchema } from '../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Чек-лист (docs/20 §14.3, §14.4): після першого прогону шкала, склад і ваги пунктів — 409. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'checklist.manage')
  const p = checklistSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте чек-лист', { issues: p.error.issues })
  const r = await upsertChecklist({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'locked') return apiError(event, 409, 'checklist.locked', 'Заповнення чек-листу вже почалось. Шкалу, склад пунктів і ваги змінювати не можна — тільки назву, опис та інструкцію', { fields: r.fields })
    if (r.code === 'bad_scale') return apiError(event, 422, 'checklist.bad_scale', 'Оберіть шкалу рівнів із числовими значеннями')
    return apiError(event, 404, 'not_found', 'Чек-лист не знайдено')
  }
  return apiData(r.checklist)
})
