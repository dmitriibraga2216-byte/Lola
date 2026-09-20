import { requireScope } from '../../../services/access'
import { catalog } from '../../../services/learning'
import { catalogPrograms } from '../../../services/programs'
import { catalogTrajectories } from '../../../services/trajectories'
import { apiData } from '../../../utils/apiResponse'

interface ProgramRow {
  id: string
  title: string
  description: string | null
  cover_key: string | null
  tags: string[]
  assignment_mode: string[]
  my_status: string | null
}

/**
 * GET /me/catalog?kind=tasks|trajectories (docs/04 §4.4, докс/10 §14.1: дві вкладки
 * «Каталог завдань» / «Каталог траєкторій навчання»). Для Lola траєкторія — це і programs
 * (лінійний режим), і trajectories (граф) — одна сутність з двома режимами показу (docs/17 §1).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.catalog')
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const query = getQuery(event)
  const kind = query.kind === 'trajectories' ? 'trajectories' as const : 'tasks' as const

  if (kind === 'trajectories') {
    const [programRows, trajectoryRows] = await Promise.all([
      catalogPrograms(ctx) as unknown as Promise<ProgramRow[]>,
      catalogTrajectories(ctx),
    ])
    const programs = programRows.map(p => ({
      id: p.id,
      type: 'program' as const,
      title: p.title,
      description: p.description,
      coverKey: p.cover_key,
      tags: p.tags,
      assignMode: p.assignment_mode.includes('catalog_free') ? 'catalog_free' as const : 'catalog_request' as const,
      status: p.my_status,
      requested: p.my_status === 'not_assigned',
    }))
    const trajectories = trajectoryRows.map(t => ({
      id: t.id,
      type: 'trajectory' as const,
      title: t.title,
      description: t.description,
      coverKey: t.coverKey,
      tags: t.tags,
      assignMode: t.assignMode,
      status: t.enrollmentStatus,
      requested: t.enrollmentStatus === 'not_assigned' && !!t.requestedAt,
    }))
    return apiData([...programs, ...trajectories])
  }

  const q = typeof query.q === 'string' ? query.q : undefined
  const categoryId = typeof query.category === 'string' ? query.category : undefined
  return apiData(await catalog(ctx, { q, categoryId }))
})
