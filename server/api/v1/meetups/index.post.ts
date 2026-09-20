import { z } from 'zod'
import { requireScope, can } from '../../../services/access'
import { createMeetup } from '../../../services/meetups'
import { apiData, apiError } from '../../../utils/apiResponse'
export const meetupSchema = z.object({
  kind: z.enum(['meetup', 'webinar', 'event']).default('meetup'), title: z.string().min(3, 'Назва від 3 символів').max(200), description: z.array(z.unknown()).optional(),
  // «Анонс» (docs/18 §14, сверено з еталоном): текст, який людина читає до запису — обов'язковий для meetup|webinar при публікації
  announcement: z.array(z.unknown()).optional(), tags: z.array(z.string().min(1).max(50)).max(20).optional(), courseId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), timezone: z.string().optional(), locationId: z.string().uuid().nullable().optional(), room: z.string().max(120).nullable().optional(), address: z.string().max(300).nullable().optional(),
  trainerIds: z.array(z.string().uuid()).min(1, 'Оберіть тренера'), capacity: z.number().int().min(1, 'Від 1 до 500').max(500, 'Від 1 до 500').nullable().optional(), waitlistEnabled: z.boolean().optional(),
  enrollDeadlineHours: z.number().int().min(0).max(720).optional(), cancelDeadlineHours: z.number().int().min(0).max(720).optional(), attendanceMode: z.enum(['manual', 'qr', 'both']).optional(),
  requiresFeedback: z.boolean().optional(), feedbackSurveyId: z.string().uuid().nullable().optional(), materials: z.array(z.string().uuid()).optional(), status: z.enum(['draft', 'planned']).optional(), coverKey: z.string().max(300).nullable().optional(), registrationRequired: z.boolean().optional(),
  webinar: z.object({ provider: z.enum(['zoom', 'meet', 'other']).optional(), joinUrl: z.string().url().nullable().optional(), hostUrl: z.string().url().nullable().optional(), recordUrl: z.string().url().nullable().optional(), recordAvailableUntil: z.string().datetime({ offset: true }).nullable().optional(), autoAttendance: z.boolean().optional(), minMinutesForAttendance: z.number().int().min(1).nullable().optional() }).optional(),
})
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.manage')
  const p = meetupSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте заняття', { issues: p.error.issues })
  if (p.data.kind === 'webinar' && !can(a, 'webinar.manage')) return apiError(event, 403, 'forbidden', 'Немає права створювати вебінари')
  const s = new Date(p.data.startsAt).getTime(), e = new Date(p.data.endsAt).getTime()
  if (s <= Date.now()) return apiError(event, 422, 'validation_failed', 'Заняття не може починатися в минулому')
  if (e <= s) return apiError(event, 422, 'validation_failed', 'Завершення має бути пізніше початку')
  if (e - s > 12 * 3_600_000) return apiError(event, 422, 'validation_failed', 'Заняття не довше 12 годин')
  if (p.data.kind !== 'event' && p.data.status !== 'draft' && !p.data.announcement?.length) return apiError(event, 422, 'validation_failed', 'Додайте анонс — його читають до запису')
  return apiData(await createMeetup({ tenantId: a.tenantId, actorId: a.userId }, p.data))
})
