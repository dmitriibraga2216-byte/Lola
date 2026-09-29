import { z } from 'zod'

/**
 * Каталог тарифов в консоли оператора (docs/24 §4.4.2, §9 «CRUD `/platform/plans`»;
 * docs/v2/35 §3.1). Поля — ровно колонки `plans`, новых не заводится. Не редактируются здесь:
 * `code` после создания (на него ссылаются `tenants.plan` и платежи), `is_active` (только
 * «В архів» / «Повернути», удаления тарифа нет), `features` и `modules` (замок модулей —
 * отдельный вопрос, см. docs/v2/44 В-21).
 */

const limit = z.number().int().min(0).max(1_000_000_000).nullable()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата у форматі РРРР-ММ-ДД')

/** Причина — как у остальных операторских действий (вход «від імені», смена тарифа): 10–500 знаков. */
export const planReasonSchema = z.string().trim().min(10, 'Причина — від 10 знаків').max(500, 'Причина — до 500 знаків')

/** Код тарифа — ключ каталога (PK), латиницей: на него ссылаются `tenants.plan` и платежи. */
export const planCodeSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,29}$/, 'Код — 2–30 символів: латиниця, цифри, «-» і «_»')

const planFields = {
  name: z.string().trim().min(2).max(120),
  titleUk: z.string().trim().max(120).nullable(),
  tier: z.number().int().min(0).max(9), // 9 тирів сітки (docs/v2/35 §3.4), 0 — поза сіткою
  maxUsers: limit, // ось users_active; null — без обмежень
  maxStorageGb: limit,
  maxSmsPerMonth: limit,
  maxCandidates: limit,
  maxAiGenerateOps: limit,
  maxAiReviewOps: limit,
  maxAiInterviewOps: limit,
  maxExportRows: limit,
  aiIncluded: z.boolean(),
  aiTermDays: z.number().int().min(1).max(3650).nullable(),
  addonsAllowed: z.array(z.string().trim().min(1).max(60)).max(50), // коды plan_addons; [] — усі
  priceUah: z.number().int().min(0).max(1_000_000_000).nullable(),
  sort: z.number().int().min(0).max(10_000),
  validFrom: isoDate,
  validTo: isoDate.nullable(),
}

const datesInOrder = (v: { validFrom?: string, validTo?: string | null }) => !v.validFrom || !v.validTo || v.validTo >= v.validFrom
const datesMessage = { message: 'Дата завершення — не раніше дати початку', path: ['validTo'] }

/** Все поля тарифа необязательны — для правки; у создания обязательны `code` и `name`. */
const optionalFields = Object.fromEntries(Object.entries(planFields).map(([k, v]) => [k, v.optional()])) as
  { [K in keyof typeof planFields]: z.ZodOptional<typeof planFields[K]> }

export const planCreateSchema = z.object({
  ...optionalFields,
  code: planCodeSchema,
  name: planFields.name,
}).strict().refine(datesInOrder, datesMessage)
export type PlanCreateInput = z.infer<typeof planCreateSchema>

/**
 * Правка тарифа: передаются только меняемые поля. `reason` обязателен, когда на тарифе есть
 * компании (сервер отвечает `422 plan.reason_required` с их числом), — формально он опционален,
 * потому что правка тарифа без компаний (черновой тир) причины не требует.
 */
export const planUpdateSchema = z.object({
  ...optionalFields,
  reason: planReasonSchema.optional(),
}).strict().refine(datesInOrder, datesMessage)
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>

/** «В архів» / «Повернути з архіву»: та сама причина, коли на тарифі є компанії. */
export const planArchiveSchema = z.object({ reason: planReasonSchema.optional() }).strict()

/** Поля тарифа, которые меняют лимиты компаний (оси `plans.max_*`, docs/v2/35 §7.3). */
export const PLAN_LIMIT_FIELDS = [
  'maxUsers', 'maxStorageGb', 'maxSmsPerMonth', 'maxCandidates',
  'maxAiGenerateOps', 'maxAiReviewOps', 'maxAiInterviewOps', 'maxExportRows',
] as const
export type PlanLimitField = typeof PLAN_LIMIT_FIELDS[number]
