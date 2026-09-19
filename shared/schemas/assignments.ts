import { z } from 'zod'
import { quizParamsSchema } from './quizzes'
import { CONTENT_TYPES } from '../enums'

/** Конструктор аудитории (docs/15 §3.2). */
export const audienceRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('position'), ids: z.array(z.string().uuid()).min(1), locationIds: z.array(z.string().uuid()).optional() }),
  z.object({ type: z.literal('location'), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('org_unit'), ids: z.array(z.string().uuid()).min(1), includeChildren: z.boolean().default(true) }),
  z.object({ type: z.literal('role'), codes: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tag'), values: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('group'), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('segment'), filter: z.object({
    hiredFrom: z.string().date().optional(),
    hiredTo: z.string().date().optional(),
    positionIds: z.array(z.string().uuid()).optional(),
    locationIds: z.array(z.string().uuid()).optional(),
    positionLevelIds: z.array(z.string().uuid()).optional(),
    certificateExpiringDays: z.number().int().min(1).max(365).optional(),
    status: z.array(z.enum(['invited', 'active'])).optional(),
    hasCompletedCourseIds: z.array(z.string().uuid()).optional(),
    notCompletedCourseIds: z.array(z.string().uuid()).optional(),
  }) }),
])

export const audienceSchema = z.object({
  rules: z.array(audienceRuleSchema).max(20),
  match: z.enum(['any', 'all']).default('any'),
})

export type Audience = z.infer<typeof audienceSchema>
export type AudienceRule = z.infer<typeof audienceRuleSchema>

/**
 * Напоминания по заданию (docs/15 Г-15.1): список дней до срока, день срока, после срока —
 * каждые N дней не больше M раз, эскалация руководителю; канал — по умолчанию человека.
 */
export const remindersSchema = z.object({
  enabled: z.boolean().default(true),
  beforeDueDays: z.array(z.number().int().min(1).max(30)).max(5).default([7, 3, 1]),
  onDueDate: z.boolean().default(true),
  afterDueEveryDays: z.number().int().min(1).max(30).nullable().default(3),
  afterDueMaxCount: z.number().int().min(1).max(5).default(5),
  escalateToManagerAfterDays: z.number().int().min(0).max(30).nullable().default(7),
  channel: z.enum(['telegram', 'sms', 'email']).nullable().default(null),
  notifyOnAssign: z.boolean().default(true),
})
export type Reminders = z.infer<typeof remindersSchema>
export const DEFAULT_REMINDERS: Reminders = remindersSchema.parse({})

// ── Параметры назначения: пять групп эталона (docs/15 §14.3, docs/02 §2.7) ─────────────
// Загальне · Термін виконання · Результат · Нагороди · Метод призначення.
// Состав «Загальне» зависит от типа контента; остальные четыре группы общие.

const q = quizParamsSchema.shape

/** Термін виконання */
const deadlineGroup = {
  deadlineMode: z.enum(['unlimited', 'days_from_assign', 'calendar']).optional(), // «Термін завершення завдання»
  timeLimitSec: q.timeLimitSec.optional(), // «Час проходження завдання» / «Час для проходження тесту»
}
/** Результат */
const resultGroup = {
  resultSource: q.resultSource.optional(), // «Результатом виконання завдання буде»
  passScore: q.passScore.optional(), // «Поріг проходження» — перекрывает порог контента
  fixResult: q.fixResult.optional(), // «Фіксувати результат завдання»
  scaleId: q.scaleId.optional(), // «Перетворити результат за шкалою»
}
/** Нагороди */
const rewardsGroup = {
  badgeId: q.badgeId.optional(),
  certificateId: q.certificateId.optional(),
  points: q.points.optional(), // рейтинг
  bonuses: q.bonuses.optional(), // магазин подарунків
}
/** Метод призначення — хранится колонками assignments (docs/02), а не в params */
export const methodGroupSchema = z.object({
  viaCatalog: z.boolean().optional(), // «Доступ через каталог навчання»
  automationRuleId: z.string().uuid().nullable().optional(), // «Автоматизація → Правило автоматизації»
  useInDevPlans: z.boolean().optional(), // «Використовувати в планах розвитку»
})
export const METHOD_KEYS = Object.keys(methodGroupSchema.shape)
/** «Інші параметри» группы «Загальне» — у всех типов */
const otherGroup = {
  allowComments: q.allowComments.optional(),
  notifyOnResult: q.notifyOnResult.optional(),
}
const common = { ...deadlineGroup, ...resultGroup, ...rewardsGroup, ...otherGroup, ...methodGroupSchema.shape }

/** «Загальне» теста: кількість питань, спроби, час, режим тренування, підгрупа «Питання» */
const testGeneral = {
  questionsMode: q.questionsMode.optional(), questionsCount: q.questionsCount.optional(),
  attemptsAllowed: q.attemptsAllowed.optional(), attemptCooldownMin: q.attemptCooldownMin.optional(),
  trainingMode: q.trainingMode.optional(), allowOtherPages: q.allowOtherPages.optional(),
  showErrorProtocol: q.showErrorProtocol.optional(), hideCorrectInProtocol: q.hideCorrectInProtocol.optional(),
  protocolAfterLastAttempt: q.protocolAfterLastAttempt.optional(),
  shuffleQuestions: q.shuffleQuestions.optional(), shuffleOptions: q.shuffleOptions.optional(),
  keepQuestionOrder: z.boolean().optional(), // «Дотримуватися послідовності питань»
  allowSkip: q.allowSkip.optional(), allowBack: q.allowBack.optional(),
  instantFeedback: q.instantFeedback.optional(), manualNext: q.manualNext.optional(),
  questionTimeLimit: q.questionTimeLimit.optional(), showAnswers: q.showAnswers.optional(),
  showScore: q.showScore.optional(), requireAllAnswered: q.requireAllAnswered.optional(),
  proctoring: z.enum(['none', 'photo', 'webcam']).optional(),
}

/** Схема параметров по типу контента — одиннадцать вариантов, дискриминатор contentType. */
export const taskParamsSchema = z.discriminatedUnion('contentType', [
  z.object({ contentType: z.literal('course'), ...common, strictOrder: z.boolean().optional(), allowEarlyFinish: z.boolean().optional() }).strict(),
  z.object({ contentType: z.literal('training_program'), ...common, strictOrder: z.boolean().optional() }).strict(),
  z.object({ contentType: z.literal('resource'), ...common }).strict(),
  z.object({ contentType: z.literal('test'), ...common, ...testGeneral }).strict(),
  z.object({ contentType: z.literal('complex_test'), ...common, attemptsAllowed: q.attemptsAllowed.optional(), attemptCooldownMin: q.attemptCooldownMin.optional(), showScore: q.showScore.optional() }).strict(),
  z.object({ contentType: z.literal('workshop'), ...common, attemptsAllowed: q.attemptsAllowed.optional() }).strict(),
  z.object({ contentType: z.literal('poll'), ...common }).strict(),
  z.object({ contentType: z.literal('assessment'), ...common }).strict(),
  z.object({ contentType: z.literal('check_list'), ...common }).strict(),
  z.object({ contentType: z.literal('meetup'), ...common }).strict(),
  z.object({ contentType: z.literal('webinar'), ...common, webinarMinWatchPct: z.number().int().min(1).max(100).optional() }).strict(), // docs/18 Г-18.2
])
export type TaskParams = z.infer<typeof taskParamsSchema>

/** Плоская схема хранения (assignments.params): объединение всех ключей; состав по типу — paramsFor(). */
export const assignmentParamsSchema = z.object({ ...common, ...testGeneral, strictOrder: z.boolean().optional(), allowEarlyFinish: z.boolean().optional(), webinarMinWatchPct: z.number().int().min(1).max(100).optional() }).omit({ viaCatalog: true, automationRuleId: true, useInDevPlans: true })
export type AssignmentParams = z.infer<typeof assignmentParamsSchema>

/** Ключи params для типа контента — выводятся из union, а не дублируются руками. */
export const PARAM_KEYS_BY_CONTENT_TYPE: Record<typeof CONTENT_TYPES[number], readonly string[]> = Object.fromEntries(
  taskParamsSchema.options.map(o => [o.shape.contentType.value, Object.keys(o.shape).filter(k => k !== 'contentType' && !METHOD_KEYS.includes(k))]),
) as unknown as Record<typeof CONTENT_TYPES[number], readonly string[]>

/** Оставить в params только ключи, допустимые для типа контента. */
export function paramsFor(contentType: typeof CONTENT_TYPES[number], params: Record<string, unknown>): AssignmentParams {
  const allowed = new Set<string>(PARAM_KEYS_BY_CONTENT_TYPE[contentType])
  return Object.fromEntries(Object.entries(params).filter(([k]) => allowed.has(k))) as AssignmentParams
}

/** Разбор PUT /tasks/:id/params: тип контента берётся из назначения, тело — параметры пяти групп. */
export function parseTaskParams(contentType: typeof CONTENT_TYPES[number], body: unknown) {
  return taskParamsSchema.safeParse({ ...(typeof body === 'object' && body ? body : {}), contentType })
}

/** Г-15.2: поведение при выходе человека из-под условия аудитории. */
export const ON_LEAVE_CONDITIONS = ['keep', 'cancel_unstarted', 'cancel_all'] as const
export type OnLeaveCondition = typeof ON_LEAVE_CONDITIONS[number]

/** Конструктор аудитории на экране назначения (docs/15 §14.4): четыре измерения, у каждого «Всі, окрім». */
export const audienceDimensionSchema = z.object({
  dimension: z.enum(['city', 'position', 'org_unit', 'tag']),
  mode: z.enum(['any', 'include', 'exclude']).default('any'),
  values: z.array(z.string().min(1)).max(200).default([]), // uuid измерения или текст метки
})
export const audienceBuilderSchema = z.object({
  dimensions: z.array(audienceDimensionSchema).max(4).default([]),
})
export type AudienceBuilder = z.infer<typeof audienceBuilderSchema>

/** POST /tasks/:id/audience/assign — явный список людей или конструктор. */
export const audienceAssignSchema = z.union([
  z.object({ userIds: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ filter: audienceBuilderSchema }),
])

/** GET /tasks/:id/audience — вкладки и фильтры эталона. */
export const audienceQuerySchema = z.object({
  tab: z.enum(['all', 'assigned', 'unassigned']).default('all'),
  q: z.string().max(100).optional(),
  positionId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  orgUnitId: z.string().uuid().optional(),
  tag: z.string().max(50).optional(),
  positionLevelId: z.string().uuid().optional(),
  via: z.enum(['manual', 'auto', 'catalog', 'trajectory', 'import', 'self', 'repeat']).optional(), // «Спосіб призначення»
  registeredFrom: z.string().date().optional(),
  registeredTo: z.string().date().optional(),
  assignedFrom: z.string().date().optional(),
  assignedTo: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})

/** Компетенции назначения (Г-15.3). */
export const assignmentCompetenciesSchema = z.object({ competencyIds: z.array(z.string().uuid()).max(50) })

/** «Додаткові параметри для завдань» (docs/15 §14.5): справочник и значения. */
export const taskParameterSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['text', 'select', 'number']).default('text'),
  options: z.array(z.string().min(1).max(120)).max(100).default([]),
  isRequired: z.boolean().default(false),
}).superRefine((p, ctx) => {
  if (p.kind === 'select' && p.options.length === 0) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Додайте варіанти для вибору' })
})
export const taskParameterValuesSchema = z.object({
  values: z.record(z.string().uuid(), z.union([z.string().max(1000), z.number(), z.null()])),
})

export const assignmentCreateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  subjectType: z.enum(CONTENT_TYPES).default('course'),
  subjectId: z.string().uuid(),
  lockVersion: z.boolean().default(false),
  audience: audienceSchema.refine(a => a.rules.length > 0, 'Додайте хоча б одну умову'),
  exclude: audienceSchema.optional(),
  startsAt: z.string().datetime().nullable().optional(),
  dueMode: z.enum(['none', 'absolute', 'relative']).default('relative'),
  dueAt: z.string().datetime().nullable().optional(),
  dueDays: z.number().int().min(1).max(365).default(14),
  isMandatory: z.boolean().default(true),
  recurrence: z.object({ everyMonths: z.number().int().min(1).max(120) }).nullable().optional(),
  params: assignmentParamsSchema.optional(),
  reminders: remindersSchema.partial().optional(),
  autoSync: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).default([]),
  status: z.enum(['draft', 'active']).default('active'),
  onLeaveCondition: z.enum(ON_LEAVE_CONDITIONS).optional(), // по умолчанию keep (БД)
  competencyIds: z.array(z.string().uuid()).max(50).optional(),
  method: methodGroupSchema.optional(),
}).superRefine((a, ctx) => {
  if (a.dueMode === 'absolute' && !a.dueAt) ctx.addIssue({ code: 'custom', path: ['dueAt'], message: 'Вкажіть дедлайн' })
  if (a.dueMode === 'absolute' && a.dueAt && a.startsAt && new Date(a.dueAt) <= new Date(a.startsAt)) {
    ctx.addIssue({ code: 'custom', path: ['dueAt'], message: 'Дедлайн має бути пізніше старту' })
  }
})

export const assignmentUpdateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  reminders: remindersSchema.partial().optional(),
  params: assignmentParamsSchema.optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  autoSync: z.boolean().optional(),
  onLeaveCondition: z.enum(ON_LEAVE_CONDITIONS).optional(),
  method: methodGroupSchema.optional(),
})

export const assignmentCancelSchema = z.object({
  reason: z.string().min(3).max(500),
  keepStarted: z.boolean().default(true),
})

export const extendSchema = z.object({
  dueAt: z.string().datetime(),
  reason: z.string().min(5).max(300),
  notify: z.boolean().default(true),
})

export const profileSchema = z.object({
  name: z.string().min(2).max(120),
  scope: z.object({
    positionIds: z.array(z.string().uuid()).default([]),
    locationIds: z.array(z.string().uuid()).default([]),
    orgUnitIds: z.array(z.string().uuid()).default([]),
  }),
  items: z.array(z.object({
    subjectType: z.enum(['course', 'test']).default('course'),
    subjectId: z.string().uuid(),
    dueDays: z.number().int().min(1).max(365).default(14),
    isMandatory: z.boolean().default(true),
    order: z.number().int().min(0).default(0),
  })).min(1).max(50),
  appliesToExisting: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

/** Правило автоматизации (docs/15 §3.6, снято с эталона): четыре группы условий с инверсией «Всі, окрім». */
export const ruleSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1000).optional(),
  trigger: z.enum(['user.activated', 'user.attributes_changed', 'user.created', 'user.placement_changed', 'course.completed', 'course.failed', 'certificate.expiring', 'assignment.overdue']),
  conditions: z.object({
    cityIds: z.array(z.string().uuid()).optional(), cityInvert: z.boolean().optional(),
    positionIds: z.array(z.string().uuid()).optional(), positionInvert: z.boolean().optional(),
    orgUnitIds: z.array(z.string().uuid()).optional(), orgUnitInvert: z.boolean().optional(),
    tags: z.array(z.string()).optional(), tagInvert: z.boolean().optional(),
    locationIds: z.array(z.string().uuid()).optional(),
    courseIds: z.array(z.string().uuid()).optional(), // для course.* — какой курс
    daysBefore: z.number().int().min(1).max(90).optional(), // для certificate.expiring
  }).default({}),
  assignDelayDays: z.number().int().min(0).max(365).default(0),
  onLeaveCondition: z.enum(ON_LEAVE_CONDITIONS).optional(), // Г-15.2, по умолчанию keep
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('assign_content'), subjectType: z.enum(['course', 'test']).default('course'), subjectId: z.string().uuid(), dueDays: z.number().int().min(1).max(365).default(14) }),
    z.object({ type: z.literal('notify_user'), code: z.string().max(50), text: z.string().max(500) }),
    z.object({ type: z.literal('notify_manager'), text: z.string().max(500) }),
    z.object({ type: z.literal('add_tag'), tag: z.string().max(50) }),
    z.object({ type: z.literal('remove_tag'), tag: z.string().max(50) }),
  ])).max(10).default([]),
  isActive: z.boolean().default(true),
  runLimit: z.object({ oncePerUser: z.boolean().default(true) }).default({ oncePerUser: true }),
})

export const templateSchema = z.object({
  code: z.string().min(2).max(60),
  channel: z.enum(['telegram', 'sms', 'email']),
  locale: z.enum(['uk', 'en']).default('uk'),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(2000),
  isEnabled: z.boolean().default(true),
  buttons: z.array(z.object({ text: z.string().min(1).max(40), action: z.string().min(1).max(200) })).max(3).optional(),
  isMandatory: z.boolean().optional(),
  throttle: z.object({ maxPerDay: z.number().int().min(1).max(50).optional(), perSubject: z.boolean().optional() }).nullable().optional(),
  escalateAfterHours: z.number().int().min(1).max(720).nullable().optional(),
  ignoreQuietHours: z.boolean().optional(),
})
