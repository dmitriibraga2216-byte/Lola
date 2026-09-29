import { requirePlatform } from '../../../../utils/platformGuard'
import { listPlansForOperator } from '../../../../services/platformPlans'
import { apiData } from '../../../../utils/apiResponse'

/** GET /platform/plans (docs/24 §9): сетка тарифов с числом компаний на каждом. */
export default defineEventHandler(async (event) => { requirePlatform(event, 'platform.read'); return apiData(await listPlansForOperator()) })
