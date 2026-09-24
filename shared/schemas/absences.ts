import { z } from 'zod'
import { ABSENCE_NORM_SCOPES } from '../enums'

/**
 * Нормы отсутствий (docs/v2/38 §3.6, §6.3, §10; блок «Кількість днів відпустки» настроек
 * компании — docs/v2/39 П-24.1). Системный дефолт — `38` §7.13: відпустка 24, лікарняний 5.
 */
export const ABSENCE_DEFAULTS = { vacationDays: 24, sickDays: 5 } as const

/** Шаг 0,5 дня, 0–365 (`38` §6.3); null — «наследую с уровня выше» (`38` §7.13). */
const days = z.number().min(0).max(365).refine(v => Number.isInteger(v * 2), 'Крок — пів дня')

/**
 * PUT /absence-norms (`38` §10). Опущенное поле — не трогать, `null` — наследовать. Оба `null`
 * снимают переопределение уровня целиком. Причина обязательна для уровня человека (`38` §6.3).
 */
export const absenceNormPutSchema = z.object({
  scopeType: z.enum(ABSENCE_NORM_SCOPES),
  scopeId: z.string().uuid().nullable().default(null),
  year: z.number().int().min(2020).max(2100),
  vacationDays: days.nullable().optional(),
  sickDays: days.nullable().optional(),
  reason: z.string().trim().min(5).max(300).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.scopeType === 'tenant') !== (v.scopeId === null)) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'Для компанії рівень без scopeId, для точки й людини — з ним' })
  if (v.scopeType === 'user' && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Вкажіть причину індивідуального коригування' })
})
export type AbsenceNormPut = z.infer<typeof absenceNormPutSchema>

export const absenceNormsQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
})
