import { requireScope } from '../../../../services/access'
import { updateSurvey } from '../../../../services/surveys'
import { pollPatchSchema } from '../../../../../shared/schemas/assessment'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Після першої відповіді (docs/20 §14.4) питання, режим, анонімність і конфіденційність заморожені — 409. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  const p = pollPatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  const r = await updateSurvey({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r.ok) {
    if (r.code === 'locked') return apiError(event, 409, 'survey.locked', 'Вже почалося заповнення опитування. Питання, режим і приватність змінювати заборонено — тільки назву, опис, мітки та строки', { fields: r.fields })
    return apiError(event, 404, 'not_found', 'Опитування не знайдено')
  }
  return apiData(r.survey)
})
