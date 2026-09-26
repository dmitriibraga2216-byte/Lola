import { z } from 'zod'
import { PLATFORM_ROLES } from '../enums'
import { TENANT_STATUSES } from './platform'
import { keysetCursorSchema } from './keyset'
import { KEYSETS } from '../domain/keyset'

/** Контракты консоли оператора: операторы, приглашение, список компаний (docs/25 §7 п. 6–8). */

export const OPERATOR_PASSWORD_MIN = 12

export const operatorInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Вкажіть e-mail'),
  fullName: z.string().trim().min(2, 'Вкажіть ПІБ').max(200),
  role: z.enum(PLATFORM_ROLES),
}).strict()
export type OperatorInviteInput = z.infer<typeof operatorInviteSchema>

export const operatorPatchSchema = z.object({
  role: z.enum(PLATFORM_ROLES).optional(),
  isActive: z.boolean().optional(),
}).strict().refine(v => v.role !== undefined || v.isActive !== undefined, 'Нічого не змінено')
export type OperatorPatchInput = z.infer<typeof operatorPatchSchema>

export const operatorTwoFactorResetSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict()

export const inviteAcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(OPERATOR_PASSWORD_MIN, `Пароль — щонайменше ${OPERATOR_PASSWORD_MIN} символів`).max(200),
}).strict()

/** Метки строки списка компаний — считает сервер, консоль показывает. */
export const TENANT_FLAGS = ['payment_overdue', 'limit_near', 'suspended'] as const
export type TenantFlag = typeof TENANT_FLAGS[number]

export const tenantListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  plan: z.string().trim().max(40).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  flag: z.enum(TENANT_FLAGS).optional(),
  cursor: keysetCursorSchema(KEYSETS.platformTenants).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type TenantListQuery = z.infer<typeof tenantListQuerySchema>
