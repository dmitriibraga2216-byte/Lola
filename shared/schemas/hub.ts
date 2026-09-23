import { z } from 'zod'
import { bodySchema } from './content'
import { NOTICE_KINDS } from '../enums'

/**
 * Контракты хаба (docs/21, docs/02 «Корпоративный хаб», Spec 21): объявления, простые объявления,
 * закладки, поиск по источникам, события, гостевая страница. Правил прохождения тут нет —
 * срок подтверждения и аудитория объявления живут в назначении (CLAUDE.md п. 11).
 */

export const NOTICE_SHOW_MODES = ['modal', 'banner', 'both'] as const
export const NOTICE_PRIORITIES = ['normal', 'important', 'critical'] as const
export const HUB_STATUSES = ['draft', 'published', 'archived'] as const

const attachmentSchema = z.object({ mediaId: z.string().uuid(), name: z.string().max(200), bytes: z.number().int().min(0).optional() })

/** Форма объявления (docs/21 §6.3, §14.5 `/notices/create`): назва, текст, файли, тип, термін, показ. */
export const noticeSchema = z.object({
  title: z.string().min(3, 'Назва від 3 символів').max(200),
  body: bodySchema.min(1, 'Додайте текст оголошення'),
  attachments: z.array(attachmentSchema).max(20).optional(),
  kind: z.enum(NOTICE_KINDS).default('acknowledge'),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  showMode: z.enum(NOTICE_SHOW_MODES).optional(),
  priority: z.enum(NOTICE_PRIORITIES).optional(),
  blockUntilAck: z.boolean().optional(),
  ackText: z.string().max(60).nullable().optional(),
  publish: z.boolean().optional(),
}).superRefine((n, ctx) => {
  if (n.startsAt && n.endsAt && new Date(n.endsAt) <= new Date(n.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Завершення має бути пізніше початку' })
})
export type NoticeInput = z.infer<typeof noticeSchema>

export const noticeUpdateSchema = noticeSchema.innerType().partial().extend({ status: z.enum(HUB_STATUSES).optional() })

/** Простое объявление (docs/21 §14.5): назва, текст, «діє до», опубліковано. */
export const simpleNoticeSchema = z.object({
  title: z.string().min(3, 'Назва від 3 символів').max(200),
  body: bodySchema.min(1, 'Додайте текст'),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  publish: z.boolean().optional(),
})
export type SimpleNoticeInput = z.infer<typeof simpleNoticeSchema>
export const simpleNoticeUpdateSchema = simpleNoticeSchema.partial().extend({ status: z.enum(HUB_STATUSES).optional() })

/** Источники поиска (docs/04 §4.13 `?in=`, docs/30: resources | news | notices; форума и wiki нет). */
export const SEARCH_SOURCES = ['all', 'resources', 'news', 'notices'] as const
export type SearchSource = typeof SEARCH_SOURCES[number]
export const searchQuerySchema = z.object({
  q: z.string().max(200).default(''),
  in: z.enum(SEARCH_SOURCES).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/** Закладка: на что она поставлена. `article` — статья базы знаний, `resource` — ресурс (урок). */
export const BOOKMARK_TYPES = ['resource', 'article', 'news', 'notice'] as const
export type BookmarkType = typeof BOOKMARK_TYPES[number]
export const bookmarkSchema = z.object({ contentType: z.enum(BOOKMARK_TYPES).default('article') })

/** Событие хаба (docs/21 §3.4, §14.6; мокап Events): над meetups(kind=event). */
export const eventSchema = z.object({
  title: z.string().min(3, 'Назва від 3 символів').max(200),
  description: bodySchema.optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  locationId: z.string().uuid().nullable().optional(), // null = «Усі точки»
  address: z.string().max(300).nullable().optional(),
  capacity: z.number().int().min(1).max(5000).nullable().optional(),
  registrationRequired: z.boolean().optional(),
  audienceLocationIds: z.array(z.string().uuid()).max(100).optional(), // кого запрошено: точки; пусто = все
  coverKey: z.string().max(300).nullable().optional(),
  publish: z.boolean().optional(),
})
export type EventInput = z.infer<typeof eventSchema>

/** Гостевая страница (docs/21 Г-21.3): три блока — приветствие, кому писать, политика данных. */
export const guestBlocksSchema = z.object({
  welcome: bodySchema.max(20).default([]),
  supportContact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().email().max(120).optional(), telegram: z.string().max(60).optional() }).default({}),
  policyUrl: z.string().url().max(500).nullable().default(null),
})
export type GuestBlocks = z.infer<typeof guestBlocksSchema>

/** Дни рождения (docs/21 §14.7): период по умолчанию — две недели, вкладки Майбутні / Минулі. */
export const birthdaysQuerySchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  tab: z.enum(['upcoming', 'past']).default('upcoming'),
})

/** Контакты (docs/21 §14.8): фильтры Підрозділ · Посада · Місто. */
export const contactsQuerySchema = z.object({
  q: z.string().max(100).optional(),
  orgUnitId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
})

export const birthdayConsentSchema = z.object({ birthdayConsent: z.boolean() })

/** PATCH /me/locale — своя мова інтерфейсу людини (докс/24 §3.6, «Профіль»); `null` — успадкувати мову тенанта. */
export const meLocaleSchema = z.object({ locale: z.enum(['uk', 'en', 'ru']).nullable() })
