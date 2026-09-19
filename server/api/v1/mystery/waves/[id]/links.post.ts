import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { createLink } from '../../../../../services/mystery'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** Одноразовая ссылка на точку: токен показывается один раз (Б.2). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.tenant')
  const p = z.object({ locationId: z.string().uuid() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Оберіть точку')
  const r = await createLink({ tenantId: a.tenantId, actorId: a.userId }, { waveId: getRouterParam(event, 'id')!, locationId: p.data.locationId })
  if (!r) return apiError(event, 409, 'wave_not_active', 'Хвиля не активна')
  return apiData({ ...r, url: `${process.env.APP_URL ?? ''}/m/${r.token}` })
})
