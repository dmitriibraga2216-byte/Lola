import { requireScope } from '../../../../services/access'
import { saveForm } from '../../../../services/assessment'
import { assessmentFormSchema } from '../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Анкета оценки (docs/20 §14.2, §14.4): после первого заполнения правка шкалы, состава и норм — 409. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.manage')
  const p = assessmentFormSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Анкета: назва, шкала і хоча б один критерій з нормою', { issues: p.error.issues })
  const r = await saveForm({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    if (r.code === 'locked') return apiError(event, 409, 'form.locked', 'Заповнення вже почалось. Шкалу, склад критеріїв і норми змінювати не можна — тільки назву, опис та інструкцію', { fields: r.fields })
    if (r.code === 'bad_scale') return apiError(event, 422, 'form.bad_scale', 'Оберіть шкалу рівнів із числовими значеннями')
    if (r.code === 'bad_norm') return apiError(event, 422, 'form.bad_norm', `Норма має бути в межах шкали (до ${r.max})`, { criterionIds: r.fields })
    return apiError(event, 404, 'not_found', 'Анкету не знайдено')
  }
  return apiData(r.form)
})
