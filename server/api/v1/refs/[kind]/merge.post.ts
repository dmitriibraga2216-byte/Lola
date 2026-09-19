import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { REF_KINDS, mergeRefs } from '../../../../services/refs'
import type { RefKind } from '../../../../services/refs'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Обʼєднання двох значень довідника (docs/16 §3.3). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const kind = getRouterParam(event, 'kind') as RefKind
  if (!REF_KINDS.includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий довідник')
  const parsed = z.object({ fromId: z.string().uuid(), intoId: z.string().uuid() }).safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Оберіть два значення', { issues: parsed.error.issues })
  const r = await mergeRefs({ tenantId: access.tenantId, actorId: access.userId }, kind, parsed.data.fromId, parsed.data.intoId)
  if (!r.ok) return apiError(event, r.code === 'not_found' ? 404 : 400, r.code, r.code === 'same' ? 'Це одне й те саме значення' : r.code === 'unsupported' ? 'Підрозділи обʼєднати не можна — перенесіть точки вручну' : 'Значення не знайдено')
  return apiData(r)
})
