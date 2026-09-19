import { z } from 'zod'
import { bodySchema } from '../../../../shared/schemas/content'
import { requireScope } from '../../../services/access'
import { createWorkshop } from '../../../services/workshops'
import { apiData, apiError } from '../../../utils/apiResponse'
export const workshopSchema = z.object({
  title: z.string().min(3).max(200), description: bodySchema.min(1),
  submissionKinds: z.array(z.enum(['text', 'photo', 'file', 'video'])).min(1),
  minTextLength: z.number().int().min(10).max(5000).nullable().optional(), maxFiles: z.number().int().min(1).max(10).optional(), maxFileMb: z.number().int().min(1).max(500).optional(),
  allowCameraOnly: z.boolean().optional(),
  criteria: z.array(z.object({ text: z.string().min(3).max(200), weight: z.number().min(0.1).max(10).optional(), isCritical: z.boolean().optional() })).min(1).max(20),
  passRule: z.object({ type: z.enum(['all_criteria', 'min_score', 'manual']), minScore: z.number().min(1).max(100).optional() }).optional(),
  reviewerRule: z.enum(['location_mentor', 'author', 'specific', 'any_mentor']).optional(), reviewerIds: z.array(z.string().uuid()).optional(),
  allowRework: z.boolean().optional(), maxReworks: z.number().int().min(0).max(5).optional(), slaHours: z.number().int().min(1).max(720).optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.create')
  const p = workshopSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте практикум', { issues: p.error.issues })
  return apiData(await createWorkshop({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
