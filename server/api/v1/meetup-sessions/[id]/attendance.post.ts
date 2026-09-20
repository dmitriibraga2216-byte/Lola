import { sessionAttendanceSchema } from '../../../../../shared/schemas/meetupSessions'
import { requireScope, can } from '../../../../services/access'
import { setAttendance } from '../../../../services/meetupSessions'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /meetup-sessions/:id/attendance — відмітка присутності (docs/18 §7.5, Г-18.1).
 * Негайно — тренер сесії; заднім числом (сесія вже завершилась) — обов'язкова причина,
 * не пізніше 7 днів, тільки керівник точки або `meetup.manage` (перевіряє сервіс).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.attendance')
  const p = sessionAttendanceSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відмітку')
  const r = await setAttendance({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data, { allowRetroactiveByScope: can(a, 'meetup.manage') })
  if (!r.ok) {
    const map: Record<string, [number, string]> = {
      not_found: [404, 'Людини немає у списку'],
      reason_required: [422, 'Вкажіть причину (від 10 символів)'],
      window_passed: [409, 'Пізно — минуло більше 7 днів після заняття'],
      forbidden: [403, 'Відмітка заднім числом доступна лише керівнику точки'],
    }
    const [st, msg] = map[r.code]!
    return apiError(event, st, `meetup.${r.code}`, msg)
  }
  return apiData(r)
})
