import { z } from 'zod'
import { publicSubmit } from '../../../../../services/mystery'
import { apiData, apiError } from '../../../../../utils/apiResponse'
const schema = z.object({
  answers: z.array(z.object({ itemId: z.string(), value: z.number().nullable(), comment: z.string().max(2000).nullable().optional(), isNa: z.boolean().optional(), photoMediaIds: z.array(z.string().uuid()).max(10).optional() })).max(200),
  startedAt: z.string().datetime({ offset: true }).optional(),
})
export default defineEventHandler(async (event) => {
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте відповіді')
  const r = await publicSubmit(getRouterParam(event, 'token')!, { ...p.data, device: getHeader(event, 'user-agent')?.slice(0, 200) })
  if (!r.ok) {
    if (r.code === 'incomplete') return apiError(event, 422, 'mystery.incomplete', 'Відмітьте всі пункти', { itemIds: r.itemIds })
    return apiError(event, r.code === 'not_found' ? 404 : 410, `mystery.${r.code}`, r.code === 'used' ? 'Це посилання вже використано' : 'Посилання застаріло')
  }
  return apiData(r)
})
