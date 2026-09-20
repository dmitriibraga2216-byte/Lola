import { z } from 'zod'
import { ASSESSMENT_KINDS, POLL_MODES, POLL_QUESTION_KINDS } from '../enums'
import { bodySchema } from './content'

/**
 * Контракты модуля оценки, чек-листов и опросов (docs/20 §14, docs/02 «Оценка и чек-листы», Spec 20).
 * Один источник для клиента и сервера (CLAUDE.md п. 7).
 */

// ── Словарь критериев (docs/20 §14.6) ──

export const criteriaGroupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  sort: z.number().int().min(0).optional(),
  weight: z.number().min(0.1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})
export type CriteriaGroupInput = z.infer<typeof criteriaGroupSchema>

export const criterionSchema = z.object({
  id: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  text: z.string().trim().min(1).max(500),
  description: z.string().max(2000).nullable().optional(),
  weight: z.number().min(0.1).max(100).optional(),
  isCritical: z.boolean().optional(),
  competencyId: z.string().uuid().nullable().optional(),
  requiresPhoto: z.boolean().optional(),
  sort: z.number().int().min(0).optional(),
})
export type CriterionInput = z.infer<typeof criterionSchema>

// ── Анкета оценки (docs/20 §14.2): тип, шкала, правила комментирования, «критерій — індикатор · Норма» ──

export const assessmentItemSchema = z.object({
  criterionId: z.string().uuid(),
  norm: z.number().min(0).max(1000),
  cluster: z.string().trim().max(200).nullable().optional(),
})

/** Поля, которые можно менять после заморозки (docs/20 §14.4): название, описание, инструкция, метки, публикация. */
export const ASSESSMENT_FORM_MUTABLE_WHEN_LOCKED = ['title', 'description', 'instruction', 'tags', 'isActive'] as const

export const assessmentFormSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(2000).nullable().optional(),
  instruction: bodySchema.optional(),
  kind: z.enum(ASSESSMENT_KINDS).default('by_criteria'),
  scaleId: z.string().uuid(),
  allowCommentGroups: z.boolean().default(false),
  commentGroupsRequired: z.boolean().default(false),
  commentWhenAboveNorm: z.boolean().default(false),
  commentWhenBelowNorm: z.boolean().default(true),
  commentWhenEqual: z.boolean().default(false),
  zeroMeansNoGrade: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  isActive: z.boolean().default(true),
  items: z.array(assessmentItemSchema).min(1).max(200),
}).superRefine((f, ctx) => {
  if (f.commentGroupsRequired && !f.allowCommentGroups) ctx.addIssue({ code: 'custom', path: ['commentGroupsRequired'], message: 'Спершу дозвольте коментувати групи' })
  const seen = new Set<string>()
  for (const [i, it] of f.items.entries()) {
    if (seen.has(it.criterionId)) ctx.addIssue({ code: 'custom', path: ['items', i], message: 'Критерій уже в анкеті' })
    seen.add(it.criterionId)
  }
})
export type AssessmentFormInput = z.infer<typeof assessmentFormSchema>

/** Ответ оценщика по критерию: значение шкалы, комментарий, «не застосовно». */
export const assessmentAnswerSchema = z.object({
  criterionId: z.string().uuid(),
  value: z.number().min(0).max(1000).nullable(),
  comment: z.string().max(2000).nullable().optional(),
  isNa: z.boolean().optional(),
})
export const assessmentAnswersSchema = z.object({
  answers: z.array(assessmentAnswerSchema).max(200),
  groupComments: z.record(z.string().max(2000)).optional(),
})

// ── Чек-лист (docs/20 §14.3): шкала одна, у пункта вес ──

export const checklistItemSchema = z.object({
  id: z.string().min(1).max(40),
  group: z.string().max(200).optional(),
  text: z.string().trim().min(1).max(500),
  criterionId: z.string().uuid().optional(),
  weight: z.number().min(0.1).max(100),
  isCritical: z.boolean().optional(),
  requiresPhoto: z.boolean().optional(),
  hint: z.string().max(300).optional(),
  // docs/33 D-037: свій поріг провалу пункта (％ від частки), опційно — інакше провал по прохідному балу чек-листа
  passThreshold: z.number().min(1).max(100).optional(),
})
export type ChecklistItemInput = z.infer<typeof checklistItemSchema>

/** Поля чек-листа, доступные после первого прогона (docs/20 §14.4). */
export const CHECKLIST_MUTABLE_WHEN_LOCKED = ['title', 'description', 'instruction', 'tags', 'isActive', 'whoCanRun', 'frequency'] as const

export const checklistSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(2000).nullable().optional(),
  instruction: bodySchema.optional(),
  kind: z.enum(['observation', 'audit', 'mystery']).default('observation'),
  scaleId: z.string().uuid(),
  items: z.array(checklistItemSchema).min(1).max(200),
  scoring: z.enum(['percent', 'points', 'pass_fail']).default('percent'),
  passScore: z.number().min(1).max(100),
  criticalFailRule: z.enum(['any_critical_fails_all', 'none']).default('any_critical_fails_all'),
  whoCanRun: z.object({ roles: z.array(z.string().min(1).max(40)).min(1).max(10) }),
  subjectKind: z.enum(['location', 'user', 'shift']).default('location'),
  frequency: z.object({ timesPerWeek: z.number().int().min(1).max(50) }).nullable().optional(),
  requireSignature: z.boolean().optional(),
  allowSkip: z.boolean().default(false),
  allowItemComment: z.boolean().default(true),
  itemCommentRequired: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  isActive: z.boolean().optional(),
}).superRefine((c, ctx) => {
  if (c.itemCommentRequired && !c.allowItemComment) ctx.addIssue({ code: 'custom', path: ['itemCommentRequired'], message: 'Спершу дозвольте коментування критеріїв' })
  const ids = new Set<string>()
  for (const [i, it] of c.items.entries()) {
    if (ids.has(it.id)) ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: 'Повторюваний пункт' })
    ids.add(it.id)
  }
})
export type ChecklistInput = z.infer<typeof checklistSchema>

// ── Опрос (docs/20 §14.5, §14.7): четыре типа вопроса, свій варіант, по шкалі, з умовами ──

const pollOptionSchema = z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(300) })

/** Переход «з умовами»: по варианту (`optionId`) или по умолчанию; `goTo` — id вопроса или `end`. */
const pollNextSchema = z.object({ optionId: z.string().min(1).max(40).optional(), goTo: z.string().min(1).max(40) })

export const pollQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(POLL_QUESTION_KINDS),
  text: z.string().trim().min(2).max(500),
  options: z.array(pollOptionSchema).max(20).optional(),
  allowOwnOption: z.boolean().optional(), // «або Свій варіант відповіді»
  allowFiles: z.boolean().optional(), // «Дозволити прикріпляти файли до відповіді»
  scaleId: z.string().uuid().optional(), // «По шкалі» — шкала уровней из словаря (scales, kind=levels)
  required: z.boolean().optional(),
  next: z.array(pollNextSchema).max(21).optional(), // только для mode=conditional
})
export type PollQuestion = z.infer<typeof pollQuestionSchema>

export const POLL_MUTABLE_WHEN_LOCKED = ['title', 'description', 'tags', 'status', 'opensAt', 'closesAt', 'triggerCourseId'] as const

export const pollSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(['survey', 'course_feedback', 'poll']).default('survey'),
  mode: z.enum(POLL_MODES).default('linear'),
  questions: z.array(pollQuestionSchema).min(1).max(60),
  isAnonymous: z.boolean().default(false),
  isConfidential: z.boolean().default(false),
  showResults: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  triggerCourseId: z.string().uuid().nullable().optional(),
}).superRefine((s, ctx) => {
  const ids = new Set(s.questions.map(q => q.id))
  if (ids.size !== s.questions.length) ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Ідентифікатори питань повторюються' })
  for (const [i, q] of s.questions.entries()) {
    if ((q.type === 'single' || q.type === 'multi') && !(q.options?.length)) ctx.addIssue({ code: 'custom', path: ['questions', i, 'options'], message: 'Додайте варіанти відповіді' })
    if (q.options && new Set(q.options.map(o => o.id)).size !== q.options.length) ctx.addIssue({ code: 'custom', path: ['questions', i, 'options'], message: 'Ідентифікатори варіантів повторюються' })
    for (const [j, n] of (q.next ?? []).entries()) {
      if (n.goTo !== 'end' && !ids.has(n.goTo)) ctx.addIssue({ code: 'custom', path: ['questions', i, 'next', j], message: 'Перехід на неіснуюче питання' })
      if (n.goTo === q.id) ctx.addIssue({ code: 'custom', path: ['questions', i, 'next', j], message: 'Перехід на себе' })
      if (n.optionId && !q.options?.some(o => o.id === n.optionId)) ctx.addIssue({ code: 'custom', path: ['questions', i, 'next', j], message: 'Умова на неіснуючий варіант' })
    }
    if (s.mode === 'linear' && q.next?.length) ctx.addIssue({ code: 'custom', path: ['questions', i, 'next'], message: 'Умови лише в режимі «з умовами»' })
  }
})
export type PollInput = z.infer<typeof pollSchema>
export const pollPatchSchema = pollSchema.innerType().partial().extend({ status: z.enum(['draft', 'active', 'closed']).optional() })
export type PollPatch = z.infer<typeof pollPatchSchema>

/** Ответ на один вопрос: single — {optionId} | {own}; multi — {optionIds, own?}; free — {text, fileIds?}; scale — {value}. */
export const pollAnswerSchema = z.union([
  z.object({ optionId: z.string().min(1).max(40) }),
  z.object({ own: z.string().trim().min(1).max(1000) }),
  z.object({ optionIds: z.array(z.string().min(1).max(40)).max(20), own: z.string().trim().max(1000).optional() }),
  z.object({ text: z.string().trim().max(5000), fileIds: z.array(z.string().uuid()).max(5).optional() }),
  z.object({ value: z.number() }),
])
export type PollAnswer = z.infer<typeof pollAnswerSchema>
export const pollAnswerRequestSchema = z.object({ questionId: z.string().min(1).max(40), answer: pollAnswerSchema.nullable() })
