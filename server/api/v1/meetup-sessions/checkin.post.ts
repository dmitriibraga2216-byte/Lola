import { sessionCheckinSchema } from '../../../../shared/schemas/meetupSessions'
import { requireScope } from '../../../services/access'
import { checkin } from '../../../services/meetupSessions'
import { apiData, apiError } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.enroll')
  const p = sessionCheckinSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Невірний код')
  const r = await checkin({ tenantId: a.tenantId, actorId: a.userId }, p.data.token)
  if (!r.ok) {
    const map: Record<string, [number, string]> = { bad_token: [400, 'Код не розпізнано'], expired: [410, 'Код застарів. Попроси тренера оновити'], not_registered: [403, 'Тебе немає у списку. Звернись до тренера'], outside_window: [409, 'Відмітка можлива за 30 хвилин до початку і до 30 хвилин після завершення'], already: [409, 'Присутність уже відмічено'] }
    const [st, msg] = map[r.code]!
    return apiError(event, st, r.code === 'expired' ? 'qr.expired' : r.code, msg, { sessionId: r.sessionId, seatsLeft: r.seatsLeft })
  }
  return apiData(r)
})
