import { z } from 'zod'
import { ORG_ASSIGNMENT_END_REASONS, ORG_ASSIGNMENT_ROLES, ORG_NODE_TYPES, ORG_SNAPSHOT_KINDS } from '../enums'

/**
 * Контракты оргструктуры (docs/v2/32-org-structure.md §6, §10). Один источник для клиента
 * и сервера (CLAUDE.md правило 7). Правила прохождения здесь искать нечего — дерево
 * подчинения к назначениям не относится вовсе.
 */

/** Подпись узла: 2…120 знаков, без `<` и `>` (`32` §3.2, форма §6.1). */
export const orgNodeTitleSchema = z.string().trim().min(2).max(120).refine(v => !/[<>]/.test(v), 'no_angle_brackets')

export const orgNodeCreateSchema = z.object({
  parentId: z.string().uuid().nullish(),
  type: z.enum(ORG_NODE_TYPES).optional(),
  title: orgNodeTitleSchema.optional(), // пусто — подставится название должности
  positionId: z.string().uuid().nullish(),
  orgUnitId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  headcountPlanned: z.number().int().min(1).max(999).optional(),
  isManagerPoint: z.boolean().optional(),
  note: z.string().max(2000).nullish(),
  externalKey: z.string().max(64).nullish(),
  sort: z.number().int().optional(),
})

export const orgNodeUpdateSchema = orgNodeCreateSchema.omit({ parentId: true, externalKey: true })

/** Перемещение ветки: `keepChildren` — «Залишити підлеглі вузли на місці» (`32` §6.2). */
export const orgNodeMoveSchema = z.object({
  parentId: z.string().uuid().nullable(),
  sort: z.number().int().optional(),
  keepChildren: z.boolean().optional(),
})

export const orgNodeReorderSchema = z.object({ sort: z.number().int() })

export const orgAssignmentCreateSchema = z.object({
  userId: z.string().uuid(),
  isPrimary: z.boolean().optional(),
  roleInNode: z.enum(ORG_ASSIGNMENT_ROLES).optional(),
  startedAt: z.string().date().optional(),
  /** Ответ на «Зробити вузол іменним?» — только у посады с планом 1 (`32` §3.2). */
  makeNamed: z.boolean().optional(),
  /** Ответ на «Людина вже має основне підпорядкування. Перенести сюди?» (`32` §6.2). */
  transferPrimary: z.boolean().optional(),
})

export const orgAssignmentEndSchema = z.object({ endedReason: z.enum(ORG_ASSIGNMENT_END_REASONS).optional() })

export const orgSnapshotCreateSchema = z.object({
  label: z.string().trim().min(2).max(120),
  kind: z.enum(ORG_SNAPSHOT_KINDS).optional(),
})

export const orgTreeQuerySchema = z.object({
  mode: z.enum(['admin', 'view']).optional(),
  includeArchived: z.coerce.boolean().optional(),
  includeVacant: z.coerce.boolean().optional(),
})

export type OrgNodeCreate = z.infer<typeof orgNodeCreateSchema>
export type OrgNodeUpdate = z.infer<typeof orgNodeUpdateSchema>
export type OrgNodeMove = z.infer<typeof orgNodeMoveSchema>
export type OrgAssignmentCreate = z.infer<typeof orgAssignmentCreateSchema>
