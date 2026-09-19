import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { notifyChanged } from '../../../../services/tasks'
import { apiData } from '../../../../utils/apiResponse'

const body = z.object({ ids: z.array(z.string().uuid()).max(500).optional() })
/** «Сповістити призначених користувачів про оновлення» — рассылка только по явной команде. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = body.safeParse((await readBody(event)) ?? {})
  return apiData(await notifyChanged({ tenantId: a.tenantId, actorId: a.userId }, p.success ? p.data.ids : undefined))
})
