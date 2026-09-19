import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { createSurvey } from '../../../services/surveys'
import { apiData, apiError } from '../../../utils/apiResponse'
const question = z.object({ id: z.string().min(1).max(32), type: z.enum(['scale', 'yesno', 'choice', 'text']), text: z.string().min(2).max(500), options: z.array(z.string().max(200)).max(10).optional(), required: z.boolean().optional() })
export const surveySchema = z.object({
  title: z.string().min(3).max(200), description: z.string().max(1000).optional(), kind: z.enum(['survey', 'course_feedback', 'poll']).default('survey'),
  questions: z.array(question).min(1).max(30), isAnonymous: z.boolean().default(false),
  opensAt: z.string().datetime().nullable().optional(), closesAt: z.string().datetime().nullable().optional(), triggerCourseId: z.string().uuid().nullable().optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'survey.manage')
  const p = surveySchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте опитування', { issues: p.error.issues })
  return apiData(await createSurvey({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
