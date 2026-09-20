import { z } from 'zod'

/**
 * Сесії очних занять і вебінарів (docs/18-meetups-webinars.md §14.1, §15 Г-18.1, Г-18.2;
 * docs/02-data-model.md «sessions»/«session_registrations»). Сесія належить НАЗНАЧЕННЮ
 * (`taskId`), а не картці контенту (CLAUDE.md п. 11): дата, місце, вмістимість, черга і
 * правила відмітки живуть тут, картка (`meetups`) лишається лише матеріалом.
 */

export const SESSION_ATTENDANCE_MODES = ['manual', 'qr', 'both'] as const
export const SESSION_ATTENDANCE_STATUSES = ['attended', 'missed', 'excused'] as const

export const sessionCreateSchema = z.object({
  taskId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().optional(),
  locationId: z.string().uuid().nullable().optional(),
  room: z.string().max(120).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  trainerIds: z.array(z.string().uuid()).min(1, 'Оберіть тренера'),
  joinUrl: z.string().url().nullable().optional(),
  hostUrl: z.string().url().nullable().optional(),
  provider: z.enum(['zoom', 'meet', 'other']).nullable().optional(),
  capacity: z.number().int().min(1, 'Від 1 до 500').max(500, 'Від 1 до 500').nullable().optional(),
  waitlistEnabled: z.boolean().optional(),
  enrollDeadlineHours: z.number().int().min(0).max(720).optional(),
  cancelDeadlineHours: z.number().int().min(0).max(720).optional(),
  attendanceMode: z.enum(SESSION_ATTENDANCE_MODES).optional(),
}).superRefine((s, ctx) => {
  if (new Date(s.endsAt).getTime() <= new Date(s.startsAt).getTime()) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Завершення має бути пізніше початку' })
  if (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime() > 12 * 3_600_000) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Сесія не довша 12 годин' })
})
export type SessionCreateInput = z.infer<typeof sessionCreateSchema>

export const sessionUpdateSchema = sessionCreateSchema.innerType().partial()

export const sessionCancelSchema = z.object({
  reason: z.string().min(10, 'Причина від 10 символів').max(500),
  notify: z.boolean().optional(),
})

export const sessionRegisterOthersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(200),
})

/**
 * Відмітка присутності (docs/18 §7.5, Г-18.1): негайно тренером — без причини; заднім числом
 * (сесія вже завершилась) — тільки з причиною ≥10 символів, не пізніше ніж за 7 днів,
 * пише в аудит (сервер сам визначає retroactive за часом, тому причина тут не обов'язкова
 * на рівні контракту — обов'язковість перевіряє сервіс, який знає час сесії).
 */
export const sessionAttendanceSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(SESSION_ATTENDANCE_STATUSES),
  reason: z.string().min(10).max(500).optional(),
})
export type SessionAttendanceInput = z.infer<typeof sessionAttendanceSchema>

export const sessionCheckinSchema = z.object({
  token: z.string().min(10).max(200),
})

/** Тік перегляду вебінару (докс/18 Г-18.2): клієнт присилає скільки секунд минуло, сервер рахує сам. */
export const sessionTickSchema = z.object({
  seconds: z.number().int().min(1).max(20),
})

export const sessionParticipationRowSchema = z.object({
  userId: z.string().uuid(),
  minutes: z.number().int().min(0).max(1440),
  joinedAt: z.string().datetime({ offset: true }).optional(),
  leftAt: z.string().datetime({ offset: true }).optional(),
})
export const sessionParticipationSchema = z.object({
  source: z.enum(['provider', 'manual']).default('manual'),
  rows: z.array(sessionParticipationRowSchema).min(1).max(1000),
})
