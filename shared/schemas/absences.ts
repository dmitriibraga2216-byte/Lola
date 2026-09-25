import { z } from 'zod'
import { ABSENCE_KINDS, ABSENCE_LIMITS, ABSENCE_NORM_SCOPES } from '../enums'

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

// ── Факты отсутствий (`38` §3.6, §6.4, §10; PR-33) ─────────────────────────────────────

/** Календарная дата `YYYY-MM-DD` — период отсутствия живёт датами, а не моментами. */
const isoDate = z.string().date()
const comment = z.string().trim().max(ABSENCE_LIMITS.commentMax).nullable().optional()

/**
 * «Внести відсутність» (`38` §6.4): вид, период, статус «Заплановано» / «Підтверджено», коментар.
 * Порядок дат и длину периода проверяет сервис — это `422 absence_record.range_invalid`, а не
 * общий `400`: форма показывает под полем периода свой текст.
 */
export const absenceRecordCreateSchema = z.object({
  kind: z.enum(ABSENCE_KINDS),
  dateFrom: isoDate,
  dateTo: isoDate,
  status: z.enum(['planned', 'approved']).default('approved'),
  comment,
}).strict()
export type AbsenceRecordCreate = z.infer<typeof absenceRecordCreateSchema>

/** Правка записи: любое поле; статус — только вперёд по `38` §4 (сервис: `absenceTransitionAllowed`). */
export const absenceRecordUpdateSchema = z.object({
  kind: z.enum(ABSENCE_KINDS).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  status: z.enum(['planned', 'approved', 'cancelled']).optional(),
  comment,
}).strict().refine(v => Object.keys(v).length > 0, 'Нічого не змінено')
export type AbsenceRecordUpdate = z.infer<typeof absenceRecordUpdateSchema>

/** GET /people/:id/absences?year= — календарный год блока «Відсутності». */
export const absenceCardQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
})
