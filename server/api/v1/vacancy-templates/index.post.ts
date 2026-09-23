import { vacancyTemplateSchema } from '../../../../shared/schemas/vacancies'
import { requireScope } from '../../../services/access'
import { createTemplate } from '../../../services/vacancyTemplates'
import { apiData, apiError } from '../../../utils/apiResponse'

/** POST /vacancy-templates — новый шаблон (docs/v2/29 §3.4, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.template.manage')
  const p = vacancyTemplateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте шаблон', { issues: p.error.issues })
  const r = await createTemplate({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.template)
  return apiError(event, 409, 'template.name_exists', 'Шаблон із такою назвою вже є')
})
