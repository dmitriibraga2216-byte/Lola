import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { RATER_KINDS, createCycle } from '../../../../services/assessment'
import { audienceSchema } from '../../../../../shared/schemas/assignments'
import { apiData, apiError } from '../../../../utils/apiResponse'
const schema = z.object({
  title: z.string().min(3).max(200), formId: z.string().uuid(), periodFrom: z.string().date(), periodTo: z.string().date(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  subjects: audienceSchema.refine(s => s.rules.length > 0, 'Оберіть, кого оцінюємо'), raterKinds: z.array(z.enum(RATER_KINDS)).min(1),
  // docs/33 D-036 (Г-20.1/Г-20.2): вага і анонімність — властивість ролі оцінювача в циклі; manager/self завжди іменні (сервіс не дає перевизначити)
  raterRoles: z.array(z.object({ kind: z.enum(RATER_KINDS), weight: z.number().min(0).max(9.99).optional(), isAnonymous: z.boolean().optional() })).max(RATER_KINDS.length).optional(),
  peersCount: z.number().int().min(1).max(10).optional(), peersSelection: z.enum(['auto', 'by_subject', 'by_manager']).optional(), anonymousForSubject: z.boolean().optional(), minRatersToShow: z.number().int().min(1).max(10).optional(), selfFirst: z.boolean().optional(), calibration: z.boolean().optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'assessment.run')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте цикл', { issues: p.error.issues })
  if (p.data.endsAt <= p.data.startsAt) return apiError(event, 422, 'validation_failed', 'Кінець вікна має бути пізніше початку')
  return apiData(await createCycle({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
