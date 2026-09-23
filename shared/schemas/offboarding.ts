import { z } from 'zod'
import { OFFBOARDING_REASONS, OFFBOARDING_STATES } from '../enums'

/**
 * Контракты офбординга и состояния человека в цикле (docs/v2/33-lifecycle.md §6.2, §10).
 * Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

/** Последний рабочий день не раньше чем сегодня − 30 дней (`33` §6.2, §12.7). */
const LAST_DAY_BACK_DAYS = 30

function notTooOld(iso: string): boolean {
  const edge = new Date()
  edge.setUTCHours(0, 0, 0, 0)
  edge.setUTCDate(edge.getUTCDate() - LAST_DAY_BACK_DAYS)
  return new Date(`${iso}T00:00:00Z`).getTime() >= edge.getTime()
}

/**
 * Запуск офбординга — форма `33` §6.2.
 *
 * `reasonText` обязателен только при `other` («Опишіть причину», 10–500). Дата задним числом
 * разрешена в пределах 30 дней — частая ситуация «человек ушёл, оформляют позже» (`33` §12.7);
 * доступ в этом случае закрывается сразу.
 */
export const offboardingStartSchema = z
  .object({
    userId: z.string().uuid(),
    reasonCode: z.enum(OFFBOARDING_REASONS),
    reasonText: z.string().trim().min(10).max(500).nullable().optional(),
    lastWorkingDay: z.string().date(),
    /** Курсы офбординга; форма предзаполняет их курсами этапа. */
    courseIds: z.array(z.string().uuid()).max(20).default([]),
    /** Выходное интервью — курс-опрос; отсутствие ключа означает «не проводить». */
    exitInterviewCourseId: z.string().uuid().nullable().optional(),
    responsibleId: z.string().uuid(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.reasonCode === 'other' && !v.reasonText) {
      ctx.addIssue({ code: 'custom', path: ['reasonText'], message: 'Опишіть причину' })
    }
    if (!notTooOld(v.lastWorkingDay)) {
      ctx.addIssue({ code: 'custom', path: ['lastWorkingDay'], message: 'Дата надто давня' })
    }
  })

export type OffboardingStartInput = z.infer<typeof offboardingStartSchema>

/** Фильтры списка случаев (`33` §5.4, §10 `GET /offboarding`). */
export const offboardingListSchema = z
  .object({
    state: z.enum(OFFBOARDING_STATES).optional(),
    locationId: z.string().uuid().optional(),
    reasonCode: z.enum(OFFBOARDING_REASONS).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    /** `true` — только активные случаи (экран открывается на них, `33` §5.4). */
    active: z.coerce.boolean().optional(),
  })
  .strict()

export type OffboardingListFilter = z.infer<typeof offboardingListSchema>

/** Передача дел закрыта (`33` §4.2, переход `handover → interview`). */
export const offboardingHandoverSchema = z.object({ done: z.literal(true) }).strict()

/** Завершение (`33` §7.7): подтверждение обязательно — операция закрывает доступ. */
export const offboardingCompleteSchema = z.object({ confirm: z.literal(true) }).strict()

/** Отмена (`33` §4.2): человек остаётся, этап возвращается к прежнему. */
export const offboardingCancelSchema = z.object({ reasonText: z.string().trim().min(3).max(500) }).strict()

/** Ручной перевод человека между этапами (`33` §7.6, §10 `POST /lifecycle/state/:userId`). */
export const lifecycleStateSetSchema = z
  .object({
    stageId: z.string().uuid(),
    reasonCode: z.string().trim().min(2).max(40).default('manual'),
    reasonText: z.string().trim().max(500).nullable().optional(),
  })
  .strict()

export type LifecycleStateSetInput = z.infer<typeof lifecycleStateSetSchema>

/**
 * Найм и **повторный** найм (`33` §7.8, критерий §13 п. 10).
 *
 * Человека ищут по телефону и `external_id` — тем же ключам, которыми он заводился. Найденный
 * получает новое размещение и этап «Онбординг», но **не** вторую запись `users`: история
 * обучения, сертификаты и прошлый период работы остаются на том же `users.id`. Поэтому ключ
 * поиска обязателен: без него найм вслепую и создал бы дубль.
 */
export const hireSchema = z
  .object({
    userId: z.string().uuid().optional(),
    phone: z.string().trim().regex(/^\+\d{10,15}$/).optional(),
    externalId: z.string().trim().min(1).max(100).optional(),
    fullName: z.string().trim().min(3).max(200).optional(),
    locationId: z.string().uuid(),
    positionId: z.string().uuid(),
    hiredAt: z.string().date().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.userId && !v.phone && !v.externalId) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Вкажіть телефон або зовнішній ідентифікатор' })
    }
  })

export type HireInput = z.infer<typeof hireSchema>
