import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { createTreeGoal } from '../../../../services/development'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Новий вузол дерева цілей (докс/19 §14.4: «Додати елемент першого рівня» без `parentId`, або підціль). */
const schema = z.object({ parentId: z.string().uuid().nullable().optional(), title: z.string().min(3).max(200), userId: z.string().uuid(), dueAt: z.string().date().nullable().optional() })
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'development.manage')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте ціль', { issues: p.error.issues })
  const r = await createTreeGoal({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (!r.ok) {
    const msg: Record<string, string> = { parent_not_found: 'Батьківський елемент не знайдено', user_not_found: 'Людину не знайдено' }
    return apiError(event, 422, `goal_tree.${r.code}`, msg[r.code]!)
  }
  return apiData(r.goal)
})
