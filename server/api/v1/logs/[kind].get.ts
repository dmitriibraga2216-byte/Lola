import { z } from 'zod'
import { SECURITY_SEVERITIES } from '../../../../shared/enums'
import { requireScope } from '../../../services/access'
import { LOG_KINDS, RETENTION_DAYS, readLog } from '../../../services/logs'
import type { LogKind } from '../../../services/logs'
import { apiData, apiError } from '../../../utils/apiResponse'
/** Журналы (docs/22 §5): фильтры по периоду, человеку, типу; доступ по audit.view. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'audit.view')
  const kind = getRouterParam(event, 'kind') as LogKind
  if (!LOG_KINDS.includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий журнал')
  const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional(), userId: z.string().uuid().optional(), type: z.string().max(80).optional(), severity: z.enum(SECURITY_SEVERITIES).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), cursor: z.string().optional() }).safeParse(getQuery(event))
  if (!q.success) return apiError(event, 400, 'validation_failed', 'Перевірте фільтри')
  const rows = await readLog({ tenantId: a.tenantId, actorId: a.userId }, kind, q.data)
  return apiData({ kind, retentionDays: RETENTION_DAYS[kind], rows })
})
