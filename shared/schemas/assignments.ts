import { z } from 'zod'
import { quizParamsSchema } from './quizzes'

/** Конструктор аудитории (docs/15 §3.2). */
export const audienceRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('position'), ids: z.array(z.string().uuid()).min(1), locationIds: z.array(z.string().uuid()).optional() }),
  z.object({ type: z.literal('location'), ids: z.array(z.string().uuid()).min(1) }),
  z.object({ type: z.literal('org_unit'), ids: z.array(z.string().uuid()).min(1), includeChildren: z.boolean().default(true) }),
  z.object({ type: z.literal('role'), codes: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tag'), values: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('segment'), filter: z.object({
    hiredFrom: z.string().date().optional(),
    hiredTo: z.string().date().optional(),
    positionIds: z.array(z.string().uuid()).optional(),
    locationIds: z.array(z.string().uuid()).optional(),
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

export const remindersSchema = z.object({
  enabled: z.boolean().default(true),
  beforeDays: z.array(z.number().int().min(1).max(30)).max(5).default([3, 1]),
  onDueDay: z.boolean().default(true),
  afterDays: z.array(z.number().int().min(1).max(30)).max(5).default([1, 3, 7]),
  channels: z.array(z.enum(['telegram', 'sms', 'email'])).min(1).default(['telegram']),
  notifyManagerAfterDays: z.number().int().min(0).max(30).nullable().default(1),
  notifyOnAssign: z.boolean().default(true),
})

export const assignmentParamsSchema = quizParamsSchema.partial().extend({
  strictOrder: z.boolean().optional(),
  allowEarlyFinish: z.boolean().optional(),
})

export const assignmentCreateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  subjectType: z.enum(['course', 'quiz', 'program']).default('course'),
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
    subjectType: z.enum(['course', 'quiz']).default('course'),
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
  actions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('assign_content'), subjectType: z.enum(['course', 'quiz']).default('course'), subjectId: z.string().uuid(), dueDays: z.number().int().min(1).max(365).default(14) }),
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
})
