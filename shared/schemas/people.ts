import { z } from 'zod'
import { phoneSchema } from './auth'

export const personCreateSchema = z.object({
  fullName: z.string().min(2).max(200),
  phone: phoneSchema.optional(),
  email: z.string().email().max(200).optional(),
  cityId: z.string().uuid().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  hiredAt: z.string().date().optional(),
  externalId: z.string().max(100).optional(),
  locale: z.enum(['uk', 'en']).optional(),
})

export const personUpdateSchema = personCreateSchema.partial().extend({
  status: z.enum(['invited', 'active', 'suspended', 'archived']).optional(),
})

export const personListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  tab: z.enum(['active', 'blocked', 'all']).default('active'),
  locationId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const placementSchema = z.object({
  locationId: z.string().uuid(),
  positionId: z.string().uuid(),
  isPrimary: z.boolean().default(true),
  startedAt: z.string().date().optional(),
})

export const roleAssignSchema = z.object({
  roleCode: z.string().min(1).max(50),
  scopeType: z.enum(['tenant', 'org_unit', 'location']),
  scopeId: z.string().uuid().nullable().optional(),
})

export const refCreateSchema = z.object({
  name: z.string().min(1).max(120),
})

export type PersonCreateInput = z.infer<typeof personCreateSchema>
export type PersonUpdateInput = z.infer<typeof personUpdateSchema>
