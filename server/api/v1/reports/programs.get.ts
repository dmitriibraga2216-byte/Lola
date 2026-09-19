import { reportScope, requireScope, scopeSql } from '../../../services/access'
import { withTenant } from '../../../utils/withTenant'
import { apiData } from '../../../utils/apiResponse'
import { sql } from 'drizzle-orm'
/** Звіт з програм (docs/17 §9): человек, программа, текущий шаг, прогресс, срок, статус. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.team')
  const scope = await reportScope(a)
  const rows = await withTenant(a.tenantId, a.userId, tx => tx.execute(sql`
    select e.id, u.full_name, p.title, p.id as program_id, e.status, e.progress_pct, e.due_at, e.completed_at,
           (select n.sort from program_nodes n where n.id = e.current_node_id) as current_step,
           (select count(*)::int from program_nodes n where n.program_id = p.id and n.node_type = 'item' and n.is_required) as total_steps
    from program_enrollments e join users u on u.id = e.user_id join programs p on p.id = e.program_id
    left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    where e.status <> 'cancelled' ${scopeSql(scope, sql`up.location_id`)} order by p.title, u.full_name limit 1000
  `)) as unknown as Record<string, unknown>[]
  return apiData(rows)
})
