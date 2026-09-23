import { z } from 'zod'
import { STAGE_CAPABILITIES } from '../enums'

/**
 * Контракты этапов жизненного цикла (docs/v2/33-lifecycle.md §3.2, §10; docs/v2/44 В-3).
 * Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

/**
 * Карта возможностей: **фиксированный** перечень ключей `STAGE_CAPABILITIES`, значения — булевы.
 * `.strict()` — то самое уточнение В-3: неизвестный ключ отвергается `422 validation_failed`,
 * а не игнорируется. Опечатка `certificat` иначе тихо выключила бы выдачу сертификата.
 * Ключ можно не передавать — отсутствующий читается как `false` (`33` §3.3).
 */
export const stageCapabilitiesSchema = z
  .object(Object.fromEntries(STAGE_CAPABILITIES.map(k => [k, z.boolean().optional()])) as Record<
    typeof STAGE_CAPABILITIES[number],
    z.ZodOptional<z.ZodBoolean>
  >)
  .strict()

export type StageCapabilitiesInput = z.infer<typeof stageCapabilitiesSchema>

/**
 * Что тенант правит у этапа (`33` §3.2, §5.2): название, иконку, цвет, порядок, включённость,
 * норму времени. `code` в список не входит и `.strict()` отвергает его с `422` — код неизменяем.
 * `capabilities` ключом здесь присутствует намеренно: тело с ним обязано получить осмысленный
 * `403 capabilities.readonly` (`33` §2, §10), а не «неизвестное поле».
 */
export const lifecycleStagePatchSchema = z
  .object({
    nameUk: z.string().trim().min(1).max(60).optional(),
    nameEn: z.string().trim().max(60).nullable().optional(),
    icon: z.string().trim().max(40).nullable().optional(),
    color: z.enum(['ink', 'sun', 'teal', 'coral']).optional(),
    sort: z.number().int().min(0).max(99).optional(),
    isEnabled: z.boolean().optional(),
    expectedDays: z.number().int().min(1).max(365).nullable().optional(),
    capabilities: stageCapabilitiesSchema.optional(),
  })
  .strict()

export type LifecycleStagePatch = z.infer<typeof lifecycleStagePatchSchema>

/** Тело платформенной ручки смены возможностей этапа (`33` §2: только оператор платформы). */
export const stageCapabilitiesPatchSchema = z.object({ capabilities: stageCapabilitiesSchema }).strict()
