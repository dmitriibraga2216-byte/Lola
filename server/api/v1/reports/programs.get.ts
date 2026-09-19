import { requireScope } from '../../../services/access'
import { withTenant } from '../../../utils/withTenant'
import { apiData } from '../../../utils/apiResponse'
import { sql } from 'drizzle-orm'
/** Звіт з програм (docs/17 §9): человек, программа, текущий шаг, прогресс, срок, статус. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const rows = await withTenant(a.tenantId, a.userId, tx => tx.execute(sql`
    select e.id, u.full_name, p.title, p.id as program_id, e.status, e.progress_pct, e.due_at, e.completed_at,
           (select n.sort from program_nodes n where n.id = e.current_node_id) as current_step,
           (select count(*)::int from program_nodes n where n.program_id = p.id and n.node_type = 'item' and n.is_required) as total_steps
    from program_enrollments e join users u on u.id = e.user_id join programs p on p.id = e.program_id
    where e.status <> 'cancelled' order by p.title, u.full_name limit 1000
  `)) as unknown as Record<string, unknown>[]
  return apiData(rows)
})
