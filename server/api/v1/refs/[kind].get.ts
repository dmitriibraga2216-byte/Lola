import { asc, eq, sql } from 'drizzle-orm'
import { TAG_SCOPES } from '../../../../shared/enums'
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
      // Мокап Dictionaries: у каждого значения — сколько людей (открытое основное размещение)
      case 'cities':
        return tx.select({ id: cities.id, name: cities.name, isActive: cities.isActive, createdAt: cities.createdAt, peopleCount: sql<number>`(select count(*)::int from user_placements up where up.is_primary and up.ended_at is null and coalesce(up.city_id, (select l.city_id from locations l where l.id = up.location_id)) = ${cities.id})` }).from(cities).orderBy(asc(cities.name))
      case 'position-levels':
        return tx.select({ id: positionLevels.id, name: positionLevels.name, sort: positionLevels.sort, peopleCount: sql<number>`(select count(*)::int from user_placements up where up.is_primary and up.ended_at is null and up.position_level_id = ${positionLevels.id})` }).from(positionLevels).orderBy(asc(positionLevels.sort), asc(positionLevels.name))
      case 'tags': {
        // Метки — только своей области (docs/16 §14.2): формы людей и аудиторий просят ?scope=user
        const scope = String(getQuery(event).scope ?? '')
        return tx.select().from(tags).where((TAG_SCOPES as readonly string[]).includes(scope) ? eq(tags.scope, scope) : sql`true`).orderBy(asc(tags.scope), asc(tags.name))
      }
      case 'positions':
        return tx.select({
          id: positions.id,
          name: positions.name,
          code: positions.code,
          levelId: positions.levelId,
          levelName: positionLevels.name,
          isActive: positions.isActive,
          peopleCount: sql<number>`(select count(*)::int from user_placements up where up.is_primary and up.ended_at is null and up.position_id = ${positions.id})`,
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
