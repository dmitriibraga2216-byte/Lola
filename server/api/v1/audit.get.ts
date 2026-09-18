import { and, desc, eq, lt } from 'drizzle-orm'
import { z } from 'zod'
import { auditLog } from '../../db/schema'
import { requireScope } from '../../services/access'
import { withTenant } from '../../utils/withTenant'
import { apiError } from '../../utils/apiResponse'

const querySchema = z.object({
  action: z.string().max(100).optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'audit.view')
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Невірні параметри')
  const { action, cursor, limit } = parsed.data

  const rows = await withTenant(access.tenantId, access.userId, async (tx) => {
    return tx.select().from(auditLog)
      .where(and(
        ...(action ? [eq(auditLog.action, action)] : []),
        ...(cursor ? [lt(auditLog.id, BigInt(cursor))] : []),
      ))
      .orderBy(desc(auditLog.id))
      .limit(limit + 1)
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    data: page.map(r => ({ ...r, id: Number(r.id) })),
    meta: { cursor: hasMore ? Number(page[page.length - 1]!.id) : null, limit },
  }
})
