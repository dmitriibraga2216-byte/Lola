import { vacancyTemplateFromVacancySchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { templateFromVacancy } from '../../../../services/vacancyTemplates'
import { viewerOf } from '../../../../services/vacancies'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancy-templates/from-vacancy/:id — «Зберегти шаблон» из формы (docs/v2/29 §7.21).
 * Снимает значения вакансии кроме точки и рекрутера (§3.4) вместе с критериями и языками.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.template.manage')
  const p = vacancyTemplateFromVacancySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть назву шаблону', { issues: p.error.issues })
  const r = await templateFromVacancy(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.template)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
  return apiError(event, 409, 'template.name_exists', 'Шаблон із такою назвою вже є')
})
