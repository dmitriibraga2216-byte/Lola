import { twoFactorStatus } from '../../../../services/twoFactor'
import { apiData } from '../../../../utils/apiResponse'
import { sessionAuth } from '../../../../utils/sessionAuth'

/**
 * GET /auth/two-factor (docs/04 §4.2, docs/24 §3.4): что показать. В промежуточной сессии —
 * шаг экрана входа (`step`: `verify` — нужен код, `enroll` — подключить фактор); в полной —
 * состояние блока «Мій вхід»: подключён ли фактор, требует ли его политика, сколько резервных
 * кодов осталось. Секретов в ответе нет никогда.
 */
export default defineEventHandler(async (event) => {
  const auth = sessionAuth(event, { allowPending: true })
  return apiData(await twoFactorStatus(auth))
})
