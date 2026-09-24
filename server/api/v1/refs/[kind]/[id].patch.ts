import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { REF_KINDS, updateRef } from '../../../../services/refs'
import type { RefKind } from '../../../../services/refs'
import { apiData, apiError } from '../../../../utils/apiResponse'

const body = z.object({
  name: z.string().min(1).max(120).optional(),
  code: z.string().max(50).nullable().optional(),
  isActive: z.boolean().optional(),
  levelId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(), // группа должности (docs/v2/39 П-24.5); null — вне группы
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  parentId: z.string().uuid().nullable().optional(),
  cityId: z.string().uuid().nullable().optional(),
  orgUnitId: z.string().uuid().optional(),
  managerId: z.string().uuid().nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  timezone: z.string().max(60).optional(),
  sort: z.number().int().optional(),
  color: z.string().max(20).nullable().optional(),
  description: z.string().max(200).nullable().optional(),
})

/** Редагування довідника (docs/16 §3.3): перейменування зберігає звʼязки, деактивація замість видалення. */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const kind = getRouterParam(event, 'kind') as RefKind
  if (!REF_KINDS.includes(kind)) return apiError(event, 404, 'not_found', 'Невідомий довідник')
  const parsed = body.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Перевірте поля', { issues: parsed.error.issues })
  try {
    const row = await updateRef({ tenantId: access.tenantId, actorId: access.userId }, kind, getRouterParam(event, 'id')!, parsed.data)
    if (!row) return apiError(event, 400, 'invalid', 'Запис не знайдено або переміщення створює цикл')
    return apiData(row)
  }
  catch (err) {
    if (String(err).includes('unique')) return apiError(event, 409, 'conflict', 'Такий запис вже існує')
    throw err
  }
})
