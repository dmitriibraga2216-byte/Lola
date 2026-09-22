import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { schedule } from '../../../services/meetups'
import { scheduleSessions } from '../../../services/meetupSessions'
import { apiData } from '../../../utils/apiResponse'
/**
 * GET /meetups — расписание с фильтрами (docs/18 §10 /meetups/schedule).
 * docs/33 D-029: события (kind=event) і немігровані картки — з картки; meetup|webinar із сесіями —
 * по рядку на кожну сесію (`meetupId` веде на картку заняття/вебінару, `id` — унікальний в об'єднаному списку).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'meetup.view')
  const q = z.object({ from: z.string().optional(), to: z.string().optional(), mine: z.coerce.boolean().optional(), kind: z.enum(['meetup', 'webinar', 'event']).optional(), locationId: z.string().uuid().optional() }).parse(getQuery(event))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const [cards, sessions] = await Promise.all([schedule(ctx, q), scheduleSessions(ctx, q)])
  const merged = [...cards, ...sessions] as Record<string, unknown>[]
  merged.sort((x, y) => new Date(x.starts_at as string).getTime() - new Date(y.starts_at as string).getTime())
  return apiData(merged)
})
