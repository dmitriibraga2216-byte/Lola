import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { upsertComplexTest } from '../../../services/complexTests'
import { apiData, apiError } from '../../../utils/apiResponse'
const schema = z.object({ id: z.string().uuid().optional(), title: z.string().min(3).max(200), parts: z.array(z.object({ quizId: z.string().uuid(), weight: z.number().min(0.1).max(100).default(1), isRequired: z.boolean().optional(), minScore: z.number().min(0).max(100).nullable().optional() })).min(2, 'Комплекс — щонайменше дві частини').max(20), passScore: z.number().min(1).max(100), timeLimitSec: z.number().int().min(60).max(86400).nullable().optional(), sequential: z.boolean().optional(), attemptsAllowed: z.number().int().min(0).max(20).optional(), showPartsResult: z.boolean().optional(), isActive: z.boolean().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'complextest.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте комплексний тест', { issues: p.error.issues })
  const r = await upsertComplexTest({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r) return apiError(event, 404, 'not_found', 'Тест не знайдено')
  return apiData(r)
})
