import { personListQuerySchema } from '../../../../shared/schemas/people'
import { can, requireScope } from '../../../services/access'
import { exportPeople } from '../../../services/people'
import { apiError } from '../../../utils/apiResponse'

/** Експорт списку в Excel (docs/16 §7.8): контакти — лише з people.edit. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'report.export')
  const parsed = personListQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри', { issues: parsed.error.issues })
  const withContacts = can(access, 'people.edit')
  const buf = await exportPeople({ tenantId: access.tenantId, actorId: access.userId }, parsed.data, { withContacts })
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="people-${new Date().toISOString().slice(0, 10)}.xlsx"`)
  return buf
})
