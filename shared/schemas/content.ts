import { z } from 'zod'

/** Блоки контента (docs/11-content-lessons.md §3.3). */

const blockBase = { id: z.string().min(1).max(64) }

export const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...blockBase, type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), text: z.string().max(200) }),
  z.object({ ...blockBase, type: z.literal('text'), html: z.string().max(50_000) }),
  z.object({ ...blockBase, type: z.literal('image'), mediaId: z.string().uuid(), alt: z.string().min(1).max(300), caption: z.string().max(300).optional(), width: z.enum(['full', 'half']).default('full') }),
  z.object({ ...blockBase, type: z.literal('video'), mediaId: z.string().uuid(), allowSeek: z.boolean().default(true) }),
  z.object({ ...blockBase, type: z.literal('file'), mediaId: z.string().uuid(), name: z.string().max(300) }),
  z.object({ ...blockBase, type: z.literal('callout'), tone: z.enum(['info', 'warn', 'danger', 'success']), title: z.string().max(200).optional(), text: z.string().max(2000) }),
  z.object({ ...blockBase, type: z.literal('checklist'), items: z.array(z.string().min(1).max(500)).min(1).max(30), requireAll: z.boolean().default(false) }),
  z.object({ ...blockBase, type: z.literal('quote'), text: z.string().max(2000), author: z.string().max(200).optional() }),
  z.object({ ...blockBase, type: z.literal('embed'), provider: z.enum(['youtube', 'vimeo']), videoId: z.string().max(100), startSec: z.number().int().min(0).optional() }),
  z.object({ ...blockBase, type: z.literal('divider') }),
])

export type ContentBlock = z.infer<typeof blockSchema>
export const bodySchema = z.array(blockSchema).max(100)

const slugSchema = z.string().regex(/^[a-z0-9-]{3,80}$/)

/** «Визначати результат проходження курсу по» (docs/11 §14.1, docs/02 §2.4): % успішності · середній бал · підсумковий тест. */
export const COURSE_RESULT_MODES = ['pct', 'avg_score', 'final_test'] as const

export const courseCreateSchema = z.object({
  title: z.string().min(3).max(200),
  slug: slugSchema.optional(),
  summary: z.string().max(300).optional(),
  categoryId: z.string().uuid().optional(),
  language: z.enum(['uk', 'en']).default('uk'),
  estimatedMinutes: z.number().int().min(1).max(600).optional(),
  strictOrder: z.boolean().default(true),
  isCatalogVisible: z.boolean().default(false),
  validityMonths: z.number().int().min(1).max(120).optional(),
  competencyId: z.string().uuid().nullable().optional(), // docs/19 §7.3: какую компетенцию закрывает курс
  competencyLevel: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  coverKey: z.string().max(300).optional(),
  // Карточка курса по эталону (docs/11 §14.1): код, иконка, длительность в днях, оценка занятости, способ подсчёта результата
  code: z.string().max(40).nullable().optional(),
  iconKey: z.string().max(300).nullable().optional(),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  workload: z.string().max(200).nullable().optional(),
  resultMode: z.enum(COURSE_RESULT_MODES).optional(), // по умолчанию pct
})

export const courseUpdateSchema = courseCreateSchema.partial()

export const moduleCreateSchema = z.object({
  title: z.string().min(1).max(200),
})

export const lessonCreateSchema = z.object({
  moduleId: z.string().uuid(),
  title: z.string().min(1).max(200),
  itemType: z.enum(['resource', 'quiz', 'workshop', 'meetup']).default('resource'),
  resource: z.object({
    body: bodySchema,
  }).optional(), // «Створити і підключити ресурс»: новый ресурс из тела
  resourceId: z.string().uuid().optional(), // подключить существующий опубликованный ресурс из библиотеки (CoursePlan)
  quizId: z.string().uuid().optional(),
  workshopId: z.string().uuid().optional(),
  meetupId: z.string().uuid().optional(), // урок-заняття (docs/29 Б.3): itemId = meetups.id, зачёт по відвідуванню сесії
  isRequired: z.boolean().default(true),
  minSeconds: z.number().int().min(10).max(3600).nullable().optional(),
  videoThresholdPct: z.number().int().min(50).max(100).default(90),
  passScorePct: z.number().min(1).max(100).nullable().optional(), // порог теста в плане курса (docs/11 §14.1); назначение перекрывает
}).refine(l => l.itemType === 'quiz' ? !!l.quizId : l.itemType === 'workshop' ? !!l.workshopId : l.itemType === 'meetup' ? !!l.meetupId : !!l.resource || !!l.resourceId, {
  message: 'Для уроку-тесту вкажіть quizId, для практикуму — workshopId, для заняття — meetupId, для матеріалу — resource або resourceId',
})

export const lessonUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: bodySchema.optional(),
  isRequired: z.boolean().optional(),
  minSeconds: z.number().int().min(10).max(3600).nullable().optional(),
  videoThresholdPct: z.number().int().min(50).max(100).optional(),
  passScorePct: z.number().min(1).max(100).nullable().optional(),
})

export const reorderSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    moduleId: z.string().uuid().optional(),
    sort: z.number().int().min(0),
  })).min(1).max(200),
})

export const publishSchema = z.object({
  changelog: z.string().min(5).max(500),
  notifyAssigned: z.boolean().default(false), // «Сповістити про оновлення» (docs/11 §14.2, docs/04 §4.8)
})

export const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(300),
  mime: z.string().min(3).max(100),
  bytes: z.number().int().min(1),
  resourceId: z.string().uuid().optional(), // для лимита «на ресурс суммарно ≤ 1 ГБ» (Г-11.4)
})

/** Тик прохождения (docs/04 §4.5, docs/11 §7.4): клиент шлёт факты (секунды, скролл, видео), сервер решает зачёт. */
export const tickSchema = z.object({
  seconds: z.number().int().min(0).max(60),
  scrollPct: z.number().int().min(0).max(100).optional(),
  videoPct: z.number().int().min(0).max(100).optional(),
  blocksState: z.record(z.unknown()).optional(),
  device: z.enum(['mobile', 'desktop']).optional(),
})
export type TickInput = z.infer<typeof tickSchema>

export const enrollSchema = z.object({
  courseId: z.string().uuid(),
})
