import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { updatePage } from '../../../../services/wiki'
import { wikiSchema } from '../index.post'
import { apiData, apiError } from '../../../../utils/apiResponse'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = wikiSchema.partial().extend({ sort: z.number().int().optional(), comment: z.string().max(300).optional() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте сторінку', { issues: p.error.issues })
  const r = await updatePage({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Сторінку не знайдено')
  if ('forbidden' in r) return apiError(event, 403, 'forbidden', 'Немає права редагувати цю гілку')
  return apiData(r)
})
