import { z } from 'zod'
import { TAG_SCOPES } from '../../../../shared/enums'
import { cities, locations, orgUnits, positionLevels, positions, tags } from '../../../db/schema'
import { requireScope } from '../../../services/access'
import { recordAudit } from '../../../services/audit'
import { withTenant } from '../../../utils/withTenant'
import { apiData, apiError } from '../../../utils/apiResponse'

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().max(50).optional(),
  levelId: z.string().uuid().optional(),
  orgUnitId: z.string().uuid().optional(),
  address: z.string().max(300).optional(),
  parentId: z.string().uuid().optional(),
  scope: z.enum(TAG_SCOPES).optional(), // метки: область обязательна (docs/16 §14.2)
})

export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const kind = getRouterParam(event, 'kind')
  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  }
  const input = parsed.data

  try {
    const row = await withTenant(access.tenantId, access.userId, async (tx) => {
      let created: unknown
      switch (kind) {
        case 'cities':
          [created] = await tx.insert(cities).values({ tenantId: access.tenantId, name: input.name }).returning()
          break
        case 'position-levels':
          [created] = await tx.insert(positionLevels).values({ tenantId: access.tenantId, name: input.name }).returning()
          break
        case 'tags':
          if (!input.scope) throw createError({ statusCode: 400, data: { code: 'validation_failed', message: 'Вкажіть область дії мітки' } })
          if (input.name.length > 40 || /[<>]/.test(input.name)) throw createError({ statusCode: 400, data: { code: 'validation_failed', message: 'Мітка — до 40 знаків без кутових дужок' } })
          ;[created] = await tx.insert(tags).values({ tenantId: access.tenantId, name: input.name, scope: input.scope }).returning()
          break
        case 'positions':
          [created] = await tx.insert(positions).values({
            tenantId: access.tenantId,
            name: input.name,
            code: input.code ?? null,
            levelId: input.levelId ?? null,
          }).returning()
          break
        case 'locations': {
          if (!input.orgUnitId) throw createError({ statusCode: 400, data: { code: 'validation_failed', message: 'Вкажіть підрозділ' } })
          ;[created] = await tx.insert(locations).values({
            tenantId: access.tenantId,
            name: input.name,
            orgUnitId: input.orgUnitId,
            address: input.address ?? null,
          }).returning()
          break
        }
        case 'org-units': {
          const path = input.name.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, '_').slice(0, 60)
          ;[created] = await tx.insert(orgUnits).values({
            tenantId: access.tenantId,
            name: input.name,
            parentId: input.parentId ?? null,
            path,
          }).returning()
          break
        }
        default:
          return null
      }
      await recordAudit(tx, {
        tenantId: access.tenantId,
        actorId: access.userId,
        action: `refs.${kind}.create`,
        entity: kind!,
        after: input,
      })
      return created
    })

    if (row === null) return apiError(event, 404, 'not_found', 'Невідомий довідник')
    return apiData(row)
  }
  catch (err) {
    if (String(err).includes('unique')) {
      return apiError(event, 409, 'conflict', 'Такий запис вже існує')
    }
    throw err
  }
})
