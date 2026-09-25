import { z } from 'zod'
import { personListQuerySchema } from '../../../../shared/schemas/people'
import { hasRatingCondition } from '../../../../shared/domain/engagementIndex'
import { areaOf, can, requireScope } from '../../../services/access'
import { exportPeople } from '../../../services/people'
import { apiError } from '../../../utils/apiResponse'

/** `includeRating=1` — явная галка «Включити індекс залученості» (docs/v2/38 §7.3 п. 2). */
const exportExtraSchema = z.object({ includeRating: z.enum(['1', 'true']).optional() })

/**
 * Експорт списку в Excel (docs/16 §7.8): контакти — лише з people.edit. Індекс залученості — не
 * за замовчуванням: лише з `includeRating=1` і правом бачити чужий індекс (docs/v2/38 §7.3, П-16.3).
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'report.export')
  const query = getQuery(event)
  const parsed = personListQuerySchema.safeParse(query)
  const extra = exportExtraSchema.safeParse(query)
  if (!parsed.success || !extra.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: [...(parsed.error?.issues ?? []), ...(extra.error?.issues ?? [])] })
  const withContacts = can(access, 'people.edit')
  const ratingArea = await areaOf(access, 'person.rating.view_others')
  const wantsRating = !!extra.data.includeRating || parsed.data.sort === 'rating' || hasRatingCondition(parsed.data)
  if (wantsRating && ratingArea === 'none') return apiError(event, 403, 'forbidden', 'Індекс залученості — лише з правом бачити чужий індекс')
  const buf = await exportPeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data, { withContacts, ratingArea, includeRating: !!extra.data.includeRating })
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="people-${new Date().toISOString().slice(0, 10)}.xlsx"`)
  return buf
})
