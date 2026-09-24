import { z } from 'zod'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Каталог навчання (docs/10-catalog-learning.md §14.1): режим доступу задаётся на стороне
 * предмета — «Вільний доступ через каталог навчання» (самозапис одразу) або «Подання заявки
 * через каталог навчання» (через модерацію). Значення узгоджені з `assign_mode` траєкторій
 * (docs/17 §14.1, docs/02): та сама лексика, лише без `manual`/`automation` — каталог курсу
 * вмикається тумблером `isCatalogVisible`, а не режимом.
 */
export const COURSE_CATALOG_MODES = ['catalog_free', 'catalog_request'] as const
export type CourseCatalogMode = typeof COURSE_CATALOG_MODES[number]

/** Заявка на курс через каталог (docs/10 §6.1: «Навіщо вам цей курс?»). */
export const catalogRequestSchema = z.object({
  comment: z.string().max(300).optional(),
})

/**
 * Рішення по заявці (docs/10 §14.1, приймання заявок): відмова обов'язково з причиною —
 * інакше людина не розуміє, чому їй відмовили.
 */
export const catalogDecideSchema = z.object({
  approve: z.boolean(),
  reason: z.string().min(3).max(500).optional(),
}).superRefine((v, ctx) => {
  if (!v.approve && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Вкажіть причину відмови' })
})

/** Тумблер «Використовувати обмеження доступу до завдань в каталозі навчання» (docs/10 §14.1). */
export const catalogSettingsSchema = z.object({ restrictAccess: z.boolean().optional() })

/** Єдина стрічка коментарів (docs/02, docs/10 §14.2). */
export const COMMENT_SOURCE_TYPES = ['task', 'course', 'program', 'knowledge', 'notice'] as const
export type CommentSourceType = typeof COMMENT_SOURCE_TYPES[number]

export const commentCreateSchema = z.object({
  sourceType: z.enum(COMMENT_SOURCE_TYPES),
  sourceId: z.string().uuid(),
  body: z.string().min(1).max(2000),
})

export const commentReplySchema = z.object({
  body: z.string().min(1).max(2000),
})

export const commentsQuerySchema = z.object({
  sourceType: z.enum(COMMENT_SOURCE_TYPES).optional(),
  isRead: z.enum(['read', 'unread']).optional(),
  cursor: keysetCursorSchema(KEYSETS.comments).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
