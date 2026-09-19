import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { saveReport } from '../../../../services/reportBuilder'
import { specSchema } from './run.post'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), name: z.string().min(2).max(120), spec: specSchema, schedule: z.object({ every: z.enum(['daily', 'weekly']), hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6).optional(), channel: z.enum(['telegram', 'email']), recipients: z.array(z.string().uuid()).min(1).max(20) }).nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.builder')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте звіт', { issues: p.error.issues })
  const r = await saveReport({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Звіт не знайдено')
  return apiData(r)
})
