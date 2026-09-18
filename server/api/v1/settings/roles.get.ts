import { asc } from 'drizzle-orm'
import { roles } from '../../../db/schema'
import { requireScope } from '../../../services/access'
import { withTenant } from '../../../utils/withTenant'
import { apiData } from '../../../utils/apiResponse'

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const rows = await withTenant(access.tenantId, access.userId, async (tx) => {
    return tx.select().from(roles).orderBy(asc(roles.code))
  })
  return apiData(rows)
})
