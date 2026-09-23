import { vacancyFromTemplateSchema } from '../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../services/access'
import { vacancyFromTemplate } from '../../../../services/vacancyTemplates'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/from-template/:tid — вакансия-черновик из шаблона (docs/v2/29 §7.21, §10).
 * Точка и рекрутер приходят телом: в шаблоне их нет — это свойство набора, а не позиции.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.edit')
  const p = vacancyFromTemplateSchema.safeParse(await readBody(event) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані', { issues: p.error.issues })
  const r = await vacancyFromTemplate({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'tid')!, p.data)
  if (r.ok) return apiData(r.vacancy)
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Шаблон не знайдено')
  return apiError(event, 422, 'validation_failed', 'Шаблон містить несумісні дані: перевірте його')
})
