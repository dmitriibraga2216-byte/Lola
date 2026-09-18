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
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  coverKey: z.string().max(300).optional(),
})

export const courseUpdateSchema = courseCreateSchema.partial()

export const moduleCreateSchema = z.object({
  title: z.string().min(1).max(200),
})

export const lessonCreateSchema = z.object({
  moduleId: z.string().uuid(),
  title: z.string().min(1).max(200),
  itemType: z.enum(['resource', 'quiz']).default('resource'), // workshop — этап 5
  resource: z.object({
    body: bodySchema,
  }).optional(),
  quizId: z.string().uuid().optional(),
  isRequired: z.boolean().default(true),
  minSeconds: z.number().int().min(10).max(3600).nullable().optional(),
  videoThresholdPct: z.number().int().min(50).max(100).default(90),
}).refine(l => l.itemType === 'quiz' ? !!l.quizId : !!l.resource, {
  message: 'Для уроку-тесту вкажіть quizId, для матеріалу — resource',
})

export const lessonUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: bodySchema.optional(),
  isRequired: z.boolean().optional(),
  minSeconds: z.number().int().min(10).max(3600).nullable().optional(),
  videoThresholdPct: z.number().int().min(50).max(100).optional(),
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
})

export const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(300),
  mime: z.string().min(3).max(100),
  bytes: z.number().int().min(1),
})

export const tickSchema = z.object({
  seconds: z.number().int().min(0).max(60),
  blocksState: z.record(z.unknown()).optional(),
  videoPct: z.number().int().min(0).max(100).optional(),
  device: z.enum(['mobile', 'desktop']).optional(),
})

export const enrollSchema = z.object({
  courseId: z.string().uuid(),
})
