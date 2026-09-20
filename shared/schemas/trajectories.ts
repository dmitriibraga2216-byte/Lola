import { z } from 'zod'
import { ASSIGN_MODES, CONTENT_TYPES } from '../enums'
import type { TRAJECTORY_NODE_KINDS } from '../enums'
import { assignmentParamsSchema } from './assignments'

/**
 * Траектория (docs/17 §14.1, §14.3, docs/02): маршрут из узлов, условия в узлах.
 * Один источник контракта для клиента и сервера (CLAUDE.md п. 7).
 */

const nodeBase = {
  id: z.string().uuid().optional(), // есть — обновить, нет — создать
  x: z.number().int().min(0).max(20000).default(0),
  y: z.number().int().min(0).max(20000).default(0),
}
const titled = z.string().min(1, 'Вкажіть назву блоку').max(120)
const days = z.number().int().min(1, 'Кількість днів — від 1').max(365)

/** Узлы — дискриминированный union по `kind` (docs/17 §14.3 + Г-17.1, Г-17.2). */
export const trajectoryNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...nodeBase, kind: z.literal('start') }),
  z.object({ ...nodeBase, kind: z.literal('finish') }),
  z.object({
    ...nodeBase,
    kind: z.literal('task'),
    title: z.string().max(200).nullable().optional(), // своё название; пусто — название контента
    contentType: z.enum(CONTENT_TYPES),
    contentId: z.string().uuid(),
    params: assignmentParamsSchema.default({}), // правила назначения, которое создаст узел (docs/15 §14.3)
  }),
  z.object({ ...nodeBase, kind: z.literal('and'), title: titled }),
  z.object({ ...nodeBase, kind: z.literal('or'), title: titled }),
  z.object({ ...nodeBase, kind: z.literal('delay'), title: titled, days }),
  z.object({ ...nodeBase, kind: z.literal('stop_delay'), title: titled, days }),
  z.object({ ...nodeBase, kind: z.literal('branch'), title: titled }),
  z.object({ ...nodeBase, kind: z.literal('mentor'), title: titled, mentorId: z.string().uuid().nullable().optional() }),
])
export type TrajectoryNodeInput = z.infer<typeof trajectoryNodeSchema>
export type TrajectoryNodeKind = typeof TRAJECTORY_NODE_KINDS[number]

/** Условие на ребре — только у исходящих из `branch` (docs/02). */
export const branchConditionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('passed') }),
  z.object({ op: z.literal('failed') }),
  z.object({ op: z.literal('score_gte'), value: z.number().min(0).max(100) }),
  z.object({ op: z.literal('else') }),
])
export type BranchCondition = z.infer<typeof branchConditionSchema>

export const trajectoryEdgeSchema = z.object({
  id: z.string().uuid().optional(),
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  condition: branchConditionSchema.nullable().optional(),
  sort: z.number().int().min(0).max(100).default(0),
})
export type TrajectoryEdgeInput = z.infer<typeof trajectoryEdgeSchema>

/** PUT /trajectories/:id/graph — полотно целиком: узлы и связи. Ссылки в рёбрах — id узлов или `tmp:*` новых. */
export const trajectoryGraphSchema = z.object({
  nodes: z.array(trajectoryNodeSchema.and(z.object({ tmpId: z.string().max(40).optional() }))).max(200),
  edges: z.array(trajectoryEdgeSchema.extend({ fromNodeId: z.string().min(1), toNodeId: z.string().min(1) })).max(400),
})
export type TrajectoryGraphInput = z.infer<typeof trajectoryGraphSchema>

export const trajectoryCreateSchema = z.object({
  title: z.string().min(3, 'Назва від 3 символів').max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
})

export const trajectoryUpdateSchema = z.object({
  title: z.string().min(3, 'Назва від 3 символів').max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  coverKey: z.string().max(500).nullable().optional(),
  assignMode: z.enum(ASSIGN_MODES).optional(),
  automationRuleId: z.string().uuid().nullable().optional(),
  stopAssignAfterFinish: z.boolean().optional(),
  status: z.enum(['draft', 'archived']).optional(), // published — только через /publish
}).superRefine((t, ctx) => {
  if (t.assignMode === 'automation' && t.automationRuleId === null) ctx.addIssue({ code: 'custom', path: ['automationRuleId'], message: 'Оберіть правило' })
})

/** POST /trajectories/:id/assign — ручное назначение (assign_mode = manual). */
export const trajectoryAssignSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1, 'Оберіть хоча б одну людину').max(1000),
})

/** Ошибка полотна: код + узел, к которому она относится; текст объясняет, что исправить. */
export const GRAPH_PROBLEM_CODES = [
  'no_start', 'no_finish', 'many_start', 'unreachable', 'no_path_to_finish', 'cycle', 'and_single_input',
  'stop_delay_before_finish', 'branch_no_else', 'branch_condition_required', 'condition_not_allowed',
  'missing_title', 'missing_days', 'missing_content', 'content_unpublished', 'branch_no_task_before', 'no_tasks',
] as const
export type GraphProblemCode = typeof GRAPH_PROBLEM_CODES[number]
export interface GraphProblem { code: GraphProblemCode, nodeId?: string, edgeId?: string, message: string }

