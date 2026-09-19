import { z } from 'zod'
import { requireScope } from '../../../services/access'
import * as R from '../../../services/reports'
import { apiData, apiError } from '../../../utils/apiResponse'

const q = z.object({
  from: z.string().date().optional(), to: z.string().date().optional(),
  locationId: z.string().uuid().optional(), positionId: z.string().uuid().optional(), courseId: z.string().uuid().optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
})

/** Отчёты docs/03 §3.9: единый каркас, фильтры, выгрузка теми же цифрами. */
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const f = q.parse(getQuery(event))
  const scope = name === 'personal' ? 'report.own' : name === 'activity' || name === 'mentors' ? 'report.tenant' : 'report.team'
  const a = await requireScope(event, scope)
  const ctx = { tenantId: a.tenantId, actorId: a.userId }

  let data: unknown
  let rows: Record<string, unknown>[] | null = null
  switch (name) {
    case 'readiness': data = rows = await R.readiness(ctx, f); break
    case 'readiness-people': {
      if (!f.locationId || !f.positionId) return apiError(event, 400, 'validation_failed', 'Вкажіть точку і посаду')
      data = rows = await R.readinessPeople(ctx, f.locationId, f.positionId); break
    }
    case 'course': {
      if (!f.courseId) return apiError(event, 400, 'validation_failed', 'Вкажіть курс')
      const r = await R.courseFunnel(ctx, f.courseId); data = r; rows = r.lessons; break
    }
    case 'overdue': data = rows = await R.overdue(ctx, f); break
    case 'attempts': data = rows = await R.attemptsReport(ctx, f); break
    case 'activity': { const r = await R.activity(ctx, f); data = r; rows = r.daily; break }
    case 'mentors': data = rows = await R.mentors(ctx, f); break
    case 'personal': { const r = await R.personal(ctx, a.userId); data = r; rows = r.enrollments; break }
    default: return apiError(event, 404, 'not_found', 'Невідомий звіт')
  }

  if (f.format === 'xlsx') {
    if (!rows) return apiError(event, 400, 'validation_failed', 'Цей звіт не вивантажується')
    if (!(await import('../../../services/access')).can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-${name}.xlsx"`)
    return R.toXlsx(name, rows)
  }
  return apiData(data)
})
