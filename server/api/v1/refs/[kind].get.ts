import { asc, eq } from 'drizzle-orm'
import {
  cities, locations, orgUnits, positionLevels, positions, tags,
} from '../../../db/schema'
import { requireScope } from '../../../services/access'
import { withTenant } from '../../../utils/withTenant'
import { apiData, apiError } from '../../../utils/apiResponse'

/** Справочники (docs/05-screens.md §5.0): міста, посади, рівні, підрозділи, точки, мітки. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'people.view')
  const kind = getRouterParam(event, 'kind')

  const rows = await withTenant(access.tenantId, access.userId, async (tx) => {
    switch (kind) {
      case 'cities':
        return tx.select().from(cities).orderBy(asc(cities.name))
      case 'position-levels':
        return tx.select().from(positionLevels).orderBy(asc(positionLevels.sort), asc(positionLevels.name))
      case 'tags':
        return tx.select().from(tags).orderBy(asc(tags.name))
      case 'positions':
        return tx.select({
          id: positions.id,
          name: positions.name,
          code: positions.code,
          levelId: positions.levelId,
          levelName: positionLevels.name,
        }).from(positions)
          .leftJoin(positionLevels, eq(positionLevels.id, positions.levelId))
          .orderBy(asc(positions.name))
      case 'locations':
        return tx.select().from(locations).orderBy(asc(locations.name))
      case 'org-units':
        return tx.select().from(orgUnits).orderBy(asc(orgUnits.path))
      default:
        return null
    }
  })

  if (rows === null) return apiError(event, 404, 'not_found', 'Невідомий довідник')
  return apiData(rows)
})
