import { z } from 'zod'
import { ruleDimensionsSchema } from '../../../../shared/schemas/assignments'
import { requireScope } from '../../../services/access'
import { previewRule } from '../../../services/automation'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Живая сводка формы: измерения ещё не сохранены. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assignment.create')
  const p = z.object({ dimensions: ruleDimensionsSchema }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте вимірювання', { issues: p.error.issues })
  return apiData(await previewRule({ tenantId: a.tenantId, actorId: a.userId }, { dimensions: p.data.dimensions }))
})
