import { z } from 'zod'
import { DISPLAY_AS } from '../enums'

/**
 * Развитие (docs/19-development.md, docs/02 Spec 19): контракты для ручной оценки компетенции,
 * профиля должности (уровни посад, «Цілі»/«Обов'язки») и настроек модуля (`display_as`).
 * Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

/**
 * Ручная оценка компетенции (docs/19 Г-19.2): всегда `source=manual`, требует причину и не
 * может быть поставлена самому себе (её ставит руководитель — «з причиною та в аудит»).
 */
export const assessCompetencyManualSchema = z.object({
  userId: z.string().uuid(),
  level: z.number().int().min(1).max(10),
  reason: z.string().trim().min(3, 'Вкажіть причину').max(500),
  validMonths: z.number().int().min(1).max(60).nullable().optional(), // null = безстроково; за замовчуванням 12 міс.
})
export type AssessCompetencyManualInput = z.infer<typeof assessCompetencyManualSchema>

/** Требование профиля к компетенции; `positionLevelId` — только при `usePositionLevels` (docs/19 §14.2). */
export const positionRequirementSchema = z.object({
  competencyId: z.string().uuid(),
  requiredLevel: z.number().int().min(1).max(10),
  isCritical: z.boolean().optional(),
  positionLevelId: z.string().uuid().nullable().optional(),
})
export type PositionRequirement = z.infer<typeof positionRequirementSchema>

export const positionProfileUpsertSchema = z.object({
  positionId: z.string().uuid(),
  positionIds: z.array(z.string().uuid()).max(30).optional(), // додаткові посади профілю (docs/19 §14.2, docs/33 D-031); головна — positionId
  positionLevelId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  goals: z.unknown().optional(), // wysiwyg-блоки «Цілі посади»
  responsibilities: z.unknown().optional(), // wysiwyg-блоки «Обов'язки посади»
  usePositionLevels: z.boolean().optional(),
  competencyRequirements: z.array(positionRequirementSchema).max(30),
  mandatoryContent: z.array(z.object({ subjectType: z.enum(['course']), subjectId: z.string().uuid(), dueDays: z.number().int().min(1).max(365) })).max(30).optional(),
  probationDays: z.number().int().min(1).max(365).nullable().optional(),
})
export type PositionProfileUpsertInput = z.infer<typeof positionProfileUpsertSchema>

/** Настройки модуля развития (docs/19 §7.4, §7.7, §14.1), хранятся в `tenants.settings.development`. */
export const developmentSettingsPatchSchema = z.object({
  goalsNeedApproval: z.boolean().optional(),
  externalTrainingThreshold: z.number().min(0).optional(),
  careerAssessmentFormId: z.string().uuid().nullable().optional(),
  competencyDisplayAs: z.enum(DISPLAY_AS).optional(),
})
export type DevelopmentSettingsPatch = z.infer<typeof developmentSettingsPatchSchema>
