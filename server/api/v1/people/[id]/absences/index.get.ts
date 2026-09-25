import { absenceCardQuerySchema } from '../../../../../../shared/schemas/absences'
import { requireAccess } from '../../../../../services/access'
import { absenceViewerOf, getAbsenceCard } from '../../../../../services/absences'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * Блок «Відсутності» карточки (docs/v2/38 §5.1, §10): по отпуску и больничному «Норма ·
 * Використано · Залишок» с источником нормы, записи за год, прошедшие во время отсутствия
 * дедлайны (§12) и права смотрящего. Свои отсутствия человек видит без скоупа.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const q = absenceCardQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Рік — від 2020 до 2100', { issues: q.error.issues })
  const r = await getAbsenceCard({ tenantId: access.tenantId, actorId: access.userId }, await absenceViewerOf(access), getRouterParam(event, 'id')!, q.data.year)
  if (!r.ok) {
    return r.code === 'not_found'
      ? apiError(event, 404, 'not_found', 'Людину не знайдено')
      : apiError(event, 403, 'forbidden', 'Немає доступу до відсутностей цієї людини')
  }
  return apiData(r.card)
})
