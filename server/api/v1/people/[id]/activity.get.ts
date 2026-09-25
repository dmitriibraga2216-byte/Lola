import { personActivityQuerySchema } from '../../../../../shared/schemas/activity'
import { requireAccess } from '../../../../services/access'
import { personActivityYear } from '../../../../services/activity'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * «Активність за {рік}» карточки человека (docs/v2/38 §5.1, §10): дни · события · уровни за год по
 * суточному агрегату. Скоупа на входе нет — свою ленту человек видит без него, наставник — ленту
 * людей из своей очереди проверки за 90 дней; права решает сервис. Кандидат и чужой тенант — `404`.
 * Журнал действий человека, который раньше отдавал этот путь, — `GET /people/:id/action-log`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireAccess(event)
  const q = personActivityQuerySchema.safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Рік має бути числом від 2000 до 2100', { issues: q.error.issues })
  const r = await personActivityYear(access, getRouterParam(event, 'id')!, q.data)
  if (!r.ok) {
    return r.code === 'not_found'
      ? apiError(event, 404, 'not_found', 'Людину не знайдено')
      : apiError(event, 403, 'forbidden', 'Немає доступу до активності цієї людини')
  }
  return apiData(r.data)
})
