import { z } from 'zod'
import { ORG_CONFLICT_KINDS, TAG_SCOPES } from '../enums'
import { phoneSchema } from './auth'
import { KEYSETS, KEYSET_CURSOR_MAX, decodeKeyset } from '../domain/keyset'
import { ENGAGEMENT_CAP } from '../domain/engagementIndex'
import { personTimezoneSchema } from './activity'

/** Метка (docs/16 §14.2): ≤ 40 знаков, без угловых скобок. */
export const tagNameSchema = z.string().trim().min(1, 'Вкажіть мітку').max(40, 'Не більше 40 знаків').regex(/^[^<>]+$/, 'Без кутових дужок')

/** CRUD /tags (docs/04 §4.11): область действия обязательна. */
export const tagCreateSchema = z.object({
  name: tagNameSchema,
  scope: z.enum(TAG_SCOPES),
  description: z.string().trim().max(200).nullable().optional(),
  color: z.enum(['sun', 'teal', 'coral', 'muted']).nullable().optional(),
})
export const tagUpdateSchema = tagCreateSchema.omit({ scope: true }).partial()
export const tagListQuerySchema = z.object({ scope: z.enum(TAG_SCOPES).optional() })

/** Профиль (docs/16 §3.1, §6.1): вход по телефону, ФИО по частям, transliteration для сертификатов. */
export const personCreateSchema = z.object({
  fullName: z.string().min(2).max(200).optional(), // собирается из частей, если не передан
  lastName: z.string().min(1, 'Вкажіть прізвище').max(60).optional(),
  firstName: z.string().min(1, 'Вкажіть імʼя').max(60).optional(),
  middleName: z.string().max(60).nullable().optional(),
  latinName: z.string().max(120).regex(/^[A-Za-z' .-]*$/, 'Лише латинські літери').nullable().optional(),
  phone: phoneSchema.optional(),
  email: z.string().email('Некоректна пошта').max(200).nullable().optional(),
  workContacts: z.object({ ext: z.string().max(20).optional(), workEmail: z.string().email().optional(), messenger: z.string().max(100).optional() }).optional(),
  birthDate: z.string().date().nullable().optional(),
  gender: z.enum(['male', 'female', 'unspecified']).nullable().optional(),
  cityId: z.string().uuid().nullable().optional(),
  tags: z.array(tagNameSchema).max(20).default([]),
  hiredAt: z.string().date().nullable().optional(),
  positionSince: z.string().date().nullable().optional(),
  externalId: z.string().max(100).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  isBlocked: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  locale: z.enum(['uk', 'en', 'ru']).nullable().optional(),
  /** Пояс удалённого человека (docs/v2/38 §3.1); `null` — по точке размещения. */
  timezone: personTimezoneSchema.optional(),
  placement: z.object({
    locationId: z.string().uuid(),
    positionId: z.string().uuid(),
    positionLevelId: z.string().uuid().nullable().optional(),
    orgUnitId: z.string().uuid().nullable().optional(),
  }).optional(), // при создании из формы (docs/16 §6.1) — сразу размещение
}).refine(p => p.fullName || (p.lastName && p.firstName), { message: 'Вкажіть прізвище та імʼя', path: ['lastName'] })
  .refine(p => !p.birthDate || (new Date(p.birthDate) < new Date(Date.now() - 14 * 365.25 * 86_400_000) && new Date(p.birthDate) > new Date('1920-01-01')), { message: 'Перевірте дату народження', path: ['birthDate'] })
  .refine(p => !p.hiredAt || !p.positionSince || p.positionSince >= p.hiredAt, { message: 'Не може бути раніше дати прийняття', path: ['positionSince'] })

export const personUpdateSchema = personCreateSchema.innerType().innerType().innerType().partial().extend({
  status: z.enum(['invited', 'active', 'suspended', 'archived']).optional(),
}).refine(p => !p.hiredAt || !p.positionSince || p.positionSince >= p.hiredAt, { message: 'Не може бути раніше дати прийняття', path: ['positionSince'] })

/** Порог фильтра по індексу залученості: 0…130 % (docs/v2/38 §7.1 — потолок 130). */
const ratingBound = z.coerce.number().min(0, 'Від 0 %').max(ENGAGEMENT_CAP, `До ${ENGAGEMENT_CAP} %`)

/** Сортировки списка людей: по дате регистрации (по умолчанию) и по індексу залученості. */
export const PEOPLE_SORTS = ['created', 'rating'] as const

/**
 * Фильтры списка людей без страницы и сортировки — они же «всі за фільтром» массового действия
 * (`bulkSchema.filter`): выбор людей в списке и в массовом действии строится одной функцией.
 */
export const peopleFilterSchema = z.object({
  q: z.string().max(200).optional(),
  tab: z.enum(['active', 'blocked', 'all']).default('active'),
  locationId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  positionLevelId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  orgUnitId: z.string().uuid().optional(),
  role: z.string().max(60).optional(),
  tag: z.string().max(50).optional(),
  registeredFrom: z.string().date().optional(),
  registeredTo: z.string().date().optional(),
  activeFrom: z.string().date().optional(),
  activeTo: z.string().date().optional(),
  includeHidden: z.coerce.boolean().optional(),
  /**
   * Індекс залученості «нижче N» / «від N» (docs/v2/38 §5.2, §7.3) — только носителю
   * `person.rating.view_others`, по людям его области; «не рассчитан» не попадает ни под один
   * порог: это не ноль. Единственным условием архивирования или блокировки быть не может —
   * `422 rating_only_filter_forbidden` (критерий §13 к. 3).
   */
  ratingLt: ratingBound.optional(),
  ratingGte: ratingBound.optional(),
})

/**
 * Курсор проверяется ключом той сортировки, которой он выдан: битый, самодельный или чужой —
 * 400, а не первая страница (`shared/schemas/keyset.ts`).
 */
export const personListQuerySchema = peopleFilterSchema.extend({
  /** `rating` — по индексу, только по убыванию (Р-35.3): «антитопа» первой страницей нет (§7.3). */
  sort: z.enum(PEOPLE_SORTS).optional(),
  cursor: z.string().max(KEYSET_CURSOR_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).superRefine((v, ctx) => {
  if (v.cursor && decodeKeyset(v.sort === 'rating' ? KEYSETS.peopleByRating : KEYSETS.people, v.cursor) === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cursor'], message: 'Курсор недійсний — оновіть список і гортайте спочатку' })
  }
})

export const placementSchema = z.object({
  locationId: z.string().uuid(),
  positionLevelId: z.string().uuid().nullable().optional(),
  cityId: z.string().uuid().nullable().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  positionId: z.string().uuid(),
  isPrimary: z.boolean().default(true),
  startedAt: z.string().date().optional(),
})

export const roleAssignSchema = z.object({
  roleCode: z.string().min(1).max(50),
  scopeType: z.enum(['tenant', 'org_unit', 'location']),
  scopeId: z.string().uuid().nullable().optional(),
  validUntil: z.string().date().nullable().optional(), // docs/16 §6.2: бессрочно (null) или до даты
  reason: z.string().trim().max(500).nullable().optional(), // причина — для аудита
})

/** Снятие роли (docs/16 §6.2): причина — в аудит. */
export const roleRevokeSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

/** POST /me/role/switch (docs/04 §4.4, docs/01 §1.9.2) */
export const roleSwitchSchema = z.object({
  roleId: z.string().uuid(),
})

/** PUT /settings/position-role-map (docs/04 §4.13): правило «должность → роль» целиком. */
export const positionRoleMapSchema = z.object({
  items: z.array(z.object({
    positionId: z.string().uuid(),
    roleCode: z.string().min(1).max(50),
    scopeType: z.enum(['tenant', 'org_unit', 'location']).default('location'),
    scopeId: z.string().uuid().nullable().optional(), // null — область размещения
  })).max(500),
})

export const refCreateSchema = z.object({
  name: z.string().min(1).max(120),
})

/** Действия над человеком (docs/16 §4, §7.4, §7.7, §7.9) */
export const archiveSchema = z.object({
  reason: z.enum(['dismissal', 'transfer', 'mistake', 'other']),
  comment: z.string().max(500).optional(),
  date: z.string().date().optional(),
  closeSessions: z.boolean().default(true),
  cancelLearning: z.boolean().default(true),
})
export const mergeSchema = z.object({ primaryId: z.string().uuid(), duplicateId: z.string().uuid() })
export const gdprEraseSchema = z.object({ userId: z.string().uuid(), reason: z.string().min(3, 'Вкажіть підставу').max(500) })
export const chiefSchema = z.object({
  userId: z.string().uuid(),
  chiefId: z.string().uuid(),
  kind: z.enum(['line', 'functional']).default('functional'),
  scope: z.string().max(120).optional(),
}).refine(c => c.userId !== c.chiefId, { message: 'Людина не може бути керівником собі', path: ['chiefId'] })
export const groupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, 'Вкажіть назву').max(120),
  kind: z.enum(['static', 'dynamic']),
  members: z.array(z.string().uuid()).max(5000).optional(),
  filter: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean().optional(),
})
export const peopleReportQuerySchema = z.object({
  kind: z.enum(['staffing', 'turnover', 'inactive']).default('staffing'),
  asOf: z.string().date().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
})
/** Импорт (docs/16 §8): маппинг колонок файла на поля и опции применения. */
export const importMappingSchema = z.object({
  mapping: z.record(z.string().max(60)).optional(),
  options: z.object({
    createRefs: z.boolean().default(true),
    archiveMissing: z.boolean().default(false),
    sendInvites: z.boolean().default(false),
  }).partial().optional(),
  presetName: z.string().max(60).optional(),
})

export type PersonCreateInput = z.infer<typeof personCreateSchema>
export type PersonUpdateInput = z.infer<typeof personUpdateSchema>

/**
 * Массовое действие (docs/16 §5.1): над отмеченными (`ids`) или над всеми по фильтру списка
 * (`filter`, «Вибрати всіх за фільтром») — ровно одно из двух. Индекс залученості не может быть
 * единственным условием архивирования (docs/v2/38 §7.3) — проверяет сервис по `filter`.
 */
export const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500).optional(),
  filter: peopleFilterSchema.optional(),
  action: z.enum(['add_tag', 'set_location', 'assign_role', 'invite', 'archive']),
  tag: tagNameSchema.optional(),
  locationId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  roleCode: z.string().max(50).optional(),
  reason: z.enum(['dismissal', 'transfer', 'mistake', 'other']).optional(),
}).refine(b => (b.ids ? 1 : 0) + (b.filter ? 1 : 0) === 1, { message: 'Позначте людей або оберіть «всі за фільтром»', path: ['ids'] })
  .refine(b => b.action !== 'add_tag' || b.tag, { message: 'Вкажіть мітку', path: ['tag'] })
  .refine(b => b.action !== 'set_location' || b.locationId, { message: 'Оберіть точку', path: ['locationId'] })
  .refine(b => b.action !== 'assign_role' || b.roleCode, { message: 'Оберіть роль', path: ['roleCode'] })

/** POST /org-conflicts/:id/resolve — разрешение конфликта оргструктуры (мокап OrgConflicts). */
export const conflictResolveSchema = z.object({
  action: z.enum(['acknowledge', 'close_placement']),
  placementId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
}).refine(c => c.action !== 'close_placement' || c.placementId, { message: 'Оберіть розміщення, яке закрити', path: ['placementId'] })

/** GET /org-conflicts — протокол с фильтром по состоянию. */
export const conflictListQuerySchema = z.object({
  state: z.enum(['open', 'resolved', 'all']).default('open'),
  kind: z.enum(ORG_CONFLICT_KINDS).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
