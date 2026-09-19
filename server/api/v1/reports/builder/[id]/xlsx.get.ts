import { reportScope, requireScope } from '../../../../../services/access'
import { savedToXlsx } from '../../../../../services/reportBuilder'
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'report.builder')
  const r = await savedToXlsx({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, await reportScope(a, 'report.team'))
  if (!r) throw createError({ statusCode: 404 })
  setHeader(event, 'content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'content-disposition', `attachment; filename="report-${r.name.replace(/[^\wЀ-ӿ-]+/g, '_').slice(0, 40)}.xlsx"`)
  return r.buffer
})
