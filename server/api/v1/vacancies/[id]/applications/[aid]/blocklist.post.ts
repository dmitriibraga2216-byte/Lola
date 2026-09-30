import { blocklistApplicationSchema } from '../../../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../../../services/access'
import { blocklistApplication } from '../../../../../../services/contactBlocklist'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/applications/:aid/blocklist — «До чорного списку» из строки отклика
 * (docs/v2/29 §7.7): телефон и почта отклика разом. Состояние отклика не меняется.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = blocklistApplicationSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return apiError(event, 422, 'validation', 'Причина — до 500 символів', { issues: p.error.issues })
  const r = await blocklistApplication({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, getRouterParam(event, 'aid')!, p.data.reason ?? null)
  if (r.ok) return apiData({ items: r.items })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Відгук не знайдено')
  if (r.code === 'duplicate') return apiError(event, 409, 'blocklist.duplicate', 'Контакти цього відгуку вже в чорному списку')
  return apiError(event, 422, 'contact.invalid', 'У відгуку немає контакту, який можна додати до списку')
})
