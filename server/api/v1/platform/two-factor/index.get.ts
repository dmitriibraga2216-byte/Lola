import { status } from '../../../../services/platformTwoFactor'
import { apiData } from '../../../../utils/apiResponse'
import { requirePlatformSession } from '../../../../utils/platformGuard'

/** GET /platform/two-factor — шаг экрана (подключить или ввести код) и состояние фактора оператора. */
export default defineEventHandler(async event => apiData(await status(requirePlatformSession(event))))
