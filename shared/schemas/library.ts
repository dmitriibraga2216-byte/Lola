import { z } from 'zod'
import { bodySchema } from './content'
import { RESOURCE_KINDS } from './resources'
import {
  LIBRARY_CONTAINER_TYPES, LIBRARY_HOLDER_TYPES, LIBRARY_PIN_MODES, LIBRARY_PROPOSAL_STATUSES,
} from '../enums'
import { CONTAINER_OF_HOLDER, LIBRARY_LIMITS as L } from '../domain/library'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты библиотеки модулей (`docs/v2/31-module-library.md` §6, §10; PR-25).
 * Один источник для клиента и сервера (CLAUDE.md п. 7). Тексты ошибок — из §6 дословно:
 * форма показывает их как есть, а сервер отдаёт их же в `details.issues`.
 *
 * Тип модуля — перечень `resources.kind` (Р-31.5, `31` §7.7): тело модуля и есть материал.
 */

/** Логический флаг из query-строки: `z.coerce.boolean()` считает `'false'` истиной. */
const queryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform(v => v === true || v === 'true' || v === '1')

const slugSchema = z.string().regex(/^[a-z0-9-]{3,80}$/, 'Код: латиниця, цифри і дефіс, від 3 до 80 символів')

const moduleFields = {
  title: z.string().trim().min(L.titleMin, 'Назва від 3 символів').max(L.titleMax, 'Назва до 200 символів'),
  slug: slugSchema.optional(),
  contentKind: z.enum(RESOURCE_KINDS, { errorMap: () => ({ message: 'Оберіть тип модуля' }) }),
  categoryId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(L.tagsMax, 'Не більше 20 міток'),
  summary: z.string().max(L.summaryMax, 'Опис до 300 символів').nullable().optional(),
  /** Владелец обязан иметь `library.publish` (§6.1) — проверяет сервис: схема людей не знает. */
  ownerId: z.string().uuid().optional(),
  /** «Співавтори» — без владельца (§6.1); вместе с ним не больше 10 (`author_ids` 1–10, §3.2). */
  coauthorIds: z.array(z.string().uuid()).max(L.authorsMax - 1, 'Не більше 9 співавторів'),
  language: z.enum(['uk', 'en']),
  estimatedMinutes: z.number().int().min(L.minutesMin, 'Від 1 до 600 хвилин').max(L.minutesMax, 'Від 1 до 600 хвилин').nullable().optional(),
  /** «Вміст» — блоки редактора `11` §5.2. Черновик может быть пустым; публикация требует ≥1 блок (§6.1). */
  body: bodySchema,
  /** Файл — для `file`/`video`, ссылка — для `link`: у тела-материала это и есть «вміст». */
  mediaId: z.string().uuid().nullable().optional(),
  externalUrl: z.string().url().max(2000).regex(/^https:\/\//, 'Посилання має починатися з https://').nullable().optional(),
}

const noOwnerDuplicate = (v: { ownerId?: string, coauthorIds?: string[] }) => !v.ownerId || !(v.coauthorIds ?? []).includes(v.ownerId)
const ownerDuplicateMessage = { message: 'Власник уже у списку', path: ['coauthorIds'] }

export const libraryModuleCreateSchema = z.object({
  ...moduleFields,
  contentKind: moduleFields.contentKind.default('article'),
  tags: moduleFields.tags.default([]),
  coauthorIds: moduleFields.coauthorIds.default([]),
  language: moduleFields.language.default('uk'),
  body: moduleFields.body.default([]),
}).refine(noOwnerDuplicate, ownerDuplicateMessage)
export type LibraryModuleCreateInput = z.infer<typeof libraryModuleCreateSchema>

export const libraryModuleUpdateSchema = z.object(moduleFields).partial().refine(noOwnerDuplicate, ownerDuplicateMessage)
export type LibraryModuleUpdateInput = z.infer<typeof libraryModuleUpdateSchema>

/**
 * Список и палитра (§5.1, §5.4, §10). `status`: по умолчанию `active` — черновики и
 * опубликованные, архив скрыт («Показати архівні» — `all` или `archived`); палитра вставки
 * просит `published`: вставляется версия, а у черновика её нет (§7.6 — архивного модуля
 * в палитре нет, критерий приёмки 4). Курсор — общий ключевой (`shared/domain/keyset.ts`),
 * битый — 422 на входе, а не первая страница.
 */
export const libraryListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(RESOURCE_KINDS).optional(),
  categoryId: z.string().uuid().optional(),
  tag: z.string().trim().max(50).optional(),
  ownerId: z.string().uuid().optional(),
  status: z.enum(['active', 'draft', 'published', 'archived', 'all']).default('active'),
  onlyUnused: queryBool.optional(),
  onlyStale: queryBool.optional(),
  cursor: keysetCursorSchema(KEYSETS.libraryModules).optional(),
  limit: z.coerce.number().int().refine(n => (L.pageSizes as readonly number[]).includes(n), '25, 50 або 100').default(25),
})
export type LibraryListQuery = z.infer<typeof libraryListQuerySchema>

/** «Причина» архивирования обязательна: её увидят авторы треков (§6.3). */
export const libraryArchiveSchema = z.object({
  reason: z.string().trim().min(L.reasonMin, 'Вкажіть причину — вона буде видна авторам треків').max(L.reasonMax, 'Причина до 500 символів'),
})

export const libraryDuplicateSchema = z.object({
  title: z.string().trim().min(L.titleMin, 'Назва від 3 символів').max(L.titleMax).optional(),
})

/** Публикация версии (§6.2). `notify` — зеркало «Сповістити про оновлення» (`11` §14.2), включён. */
export const libraryPublishVersionSchema = z.object({
  changelog: z.string().trim().min(L.changelogMin, 'Опишіть зміни — це побачать автори треків').max(L.changelogMax, 'Опис змін до 500 символів'),
  isHotfix: z.boolean().default(false),
  notify: z.boolean().default(true),
  /**
   * Какую версию автор собирается выпустить (форма знает «v4»). Не совпала с фактической —
   * кто-то опубликовал раньше: `409 version_conflict`, а не молчаливая v5 поверх чужой v4 (§12).
   */
  expectedVersion: z.number().int().min(1).optional(),
})
export type LibraryPublishVersionInput = z.infer<typeof libraryPublishVersionSchema>

/** Вставка модуля в место использования (§10 `POST /library/usages`). Контейнер обязан совпадать с видом держателя. */
export const libraryAttachSchema = z.object({
  libraryModuleId: z.string().uuid(),
  holderType: z.enum(LIBRARY_HOLDER_TYPES),
  holderId: z.string().uuid(),
  containerType: z.enum(LIBRARY_CONTAINER_TYPES),
  containerId: z.string().uuid(),
  pinMode: z.enum(LIBRARY_PIN_MODES).default('hotfix_auto'),
}).refine(v => CONTAINER_OF_HOLDER[v.holderType] === v.containerType, {
  message: 'Вузол належить траєкторії, урок — курсу',
  path: ['containerType'],
})
export type LibraryAttachInput = z.infer<typeof libraryAttachSchema>

export const libraryUsagesQuerySchema = z.object({
  includeDetached: queryBool.optional(),
})

/** «Запропонувати в бібліотеку» (§6.3). Пояснение обязательно — иначе куратор не поймёт, зачем. */
export const libraryProposalCreateSchema = z.object({
  sourceLessonId: z.string().uuid(),
  proposedTitle: z.string().trim().min(L.titleMin, 'Назва від 3 символів').max(L.titleMax).optional(),
  proposedCategoryId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().min(1, 'Поясніть, чому це варто перевикористовувати').max(L.proposalCommentMax, 'Пояснення до 500 символів'),
})

export const libraryProposalsQuerySchema = z.object({
  status: z.enum(LIBRARY_PROPOSAL_STATUSES).optional(),
})

export const libraryProposalAcceptSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid().optional(),
})

/** Отказ без комментария не принимается (§3.5, констрейнт в БД): автор предложения должен понять почему. */
export const libraryProposalRejectSchema = z.object({
  decisionComment: z.string().trim().min(L.decisionCommentMin, 'Поясніть рішення — його побачить автор пропозиції').max(L.decisionCommentMax),
})
