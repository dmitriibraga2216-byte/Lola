import { z } from 'zod'
import { phoneSchema } from './auth'

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
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  hiredAt: z.string().date().nullable().optional(),
  positionSince: z.string().date().nullable().optional(),
  externalId: z.string().max(100).nullable().optional(),
  comment: z.string().max(2000).nullable().optional(),
  isBlocked: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  locale: z.enum(['uk', 'en']).nullable().optional(),
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

export const personListQuerySchema = z.object({
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
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
export const noteSchema = z.object({ body: z.string().min(1, 'Порожня нотатка').max(2000) })
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

export const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(['add_tag', 'set_location', 'assign_role', 'invite', 'archive']),
  tag: z.string().min(1).max(50).optional(),
  locationId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  roleCode: z.string().max(50).optional(),
  reason: z.enum(['dismissal', 'transfer', 'mistake', 'other']).optional(),
}).refine(b => b.action !== 'add_tag' || b.tag, { message: 'Вкажіть мітку', path: ['tag'] })
  .refine(b => b.action !== 'set_location' || b.locationId, { message: 'Оберіть точку', path: ['locationId'] })
  .refine(b => b.action !== 'assign_role' || b.roleCode, { message: 'Оберіть роль', path: ['roleCode'] })
