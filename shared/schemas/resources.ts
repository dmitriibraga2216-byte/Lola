import { z } from 'zod'
import { bodySchema } from './content'
import { COURSE_CATALOG_MODES } from './catalog'

/**
 * Ресурс как тип контента (docs/11 §3.1, §14, Г-11.3, Г-11.5; docs/32 Б.7).
 * В ресурсе нет правил прохождения (CLAUDE.md п. 11): только материал, доступ, обложки.
 * Что считается «пройдено» для типа — правило зачёта (Г-11.5), оно свойство типа, не назначения.
 */

/** Типы ресурса: страница из блоков, файл, видео, ссылка. SCORM — R3 (Г-11.6). */
export const RESOURCE_KINDS = ['article', 'file', 'video', 'link'] as const
export type ResourceKind = typeof RESOURCE_KINDS[number]

export const RESOURCE_STATUSES = ['draft', 'published', 'archived'] as const

/** Форматы обложки — как в эталоне (docs/11 §14): 16:9, jpg/png/jpeg/gif/svg/webp. */
export const COVER_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp'] as const

const slugSchema = z.string().regex(/^[a-z0-9-]{3,80}$/)

const resourceBase = {
  title: z.string().min(3, 'Назва від 3 символів').max(200),
  slug: slugSchema.optional(),
  kind: z.enum(RESOURCE_KINDS).default('article'),
  summary: z.string().max(300).nullable().optional(),
  body: bodySchema.default([]),
  mediaId: z.string().uuid().nullable().optional(),
  externalUrl: z.string().url().max(2000).regex(/^https:\/\//, 'Посилання має починатися з https://').nullable().optional(),
  categoryIds: z.array(z.string().uuid()).max(20).default([]),
  tags: z.array(z.string().min(1).max(50)).max(20, 'Не більше 20 міток').default([]),
  language: z.enum(['uk', 'en']).default('uk'),
  estimatedMinutes: z.number().int().min(1, 'Від 1 до 600 хвилин').max(600, 'Від 1 до 600 хвилин').nullable().optional(),
  coverKey: z.string().max(300).nullable().optional(),
  cardImageKey: z.string().max(300).nullable().optional(),
  allowPrint: z.boolean().default(true),
  authorIds: z.array(z.string().uuid()).max(20).optional(), // по умолчанию — создатель
  accessGroupIds: z.array(z.string().uuid()).max(50).optional(), // пусто — открыт всем
  // Каталог навчання (docs/10 §5.2, docs/33 D-060) — той самий словник, що й у курсу (shared/schemas/catalog.ts).
  // Без .default() навмисно (на відміну від courses.isCatalogVisible) — інакше поле стає обов'язковим
  // у z.infer для CreateInput і ламає всі наявні виклики createResource() без цього поля; дефолт — у сервісі.
  isCatalogVisible: z.boolean().optional(),
  assignMode: z.enum(COURSE_CATALOG_MODES).optional(),
}

/** Файл — для file/video, ссылка — для link. Проверяется при публикации, черновик может быть неполным. */
export function resourceKindComplete(v: { kind: ResourceKind, mediaId?: string | null, externalUrl?: string | null, body?: unknown[] }): boolean {
  if ((v.kind === 'file' || v.kind === 'video') && !v.mediaId) return false
  if (v.kind === 'link' && !v.externalUrl) return false
  if (v.kind === 'article' && !(v.body?.length)) return false
  return true
}

export const resourceCreateSchema = z.object(resourceBase)
export const resourceUpdateSchema = z.object(resourceBase).partial().extend({
  expectedVersion: z.number().int().min(1).optional(), // оптимистическая блокировка (docs/11 §12)
})

export const resourcePublishSchema = z.object({
  changelog: z.string().max(500).nullable().optional(),
  notifyAssigned: z.boolean().default(false), // «Сповістити про оновлення» (docs/11 §14.2)
})

export const resourceListQuerySchema = z.object({
  status: z.enum(['all', 'draft', 'published', 'archived']).default('all'),
  kind: z.enum(RESOURCE_KINDS).optional(),
  authorId: z.string().uuid().optional(),
  tag: z.string().max(50).optional(),
  categoryId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(10).max(100).default(25),
})

export const resourceCategorySchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
})
export const resourceCategoryReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
})

/** Группы доступа (docs/02 access_groups, docs/21 §14.1). */
export const ACCESS_SUBJECT_TYPES = ['position', 'org_unit', 'user', 'role'] as const
export type AccessSubjectType = typeof ACCESS_SUBJECT_TYPES[number]
export const accessGroupSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  appliesTo: z.enum(['knowledge', 'catalog']).default('knowledge'),
  members: z.array(z.object({
    subjectType: z.enum(ACCESS_SUBJECT_TYPES),
    subjectId: z.string().uuid(),
  })).max(500).optional(),
})

/**
 * Правила зачёта по типу (Г-11.5). Константы правила — свойство типа контента, не назначения:
 * видео ≥ 90 % длительности; страница — доскроллена + время чтения (180 слов/мин, минимум 20 с);
 * документ — пролистан до конца либо скачан + 15 с/страницу, не больше 10 минут; ссылка — «Я ознайомився».
 */
export const COMPLETION_RULES = {
  video: { minPct: 90 },
  article: { wordsPerMinute: 180, minSeconds: 20, scrollPct: 100 },
  file: { secondsPerPage: 15, maxSeconds: 600, scrollPct: 100 },
  link: { acknowledge: true },
} as const
