import { z } from 'zod'
import { orgImportRemapSchema } from '../../../../../../shared/schemas/orgStructure'
import { requireScope } from '../../../../../services/access'
import { remapOrgImport } from '../../../../../services/orgImport'
import { apiData, apiError } from '../../../../../utils/apiResponse'

const STATUS = { not_found: 404, not_ready: 409, mapping_invalid: 422 } as const
const MESSAGE = {
  not_found: 'Імпорт не знайдено',
  not_ready: 'Імпорт уже запущено — змінити його не можна',
  mapping_invalid: 'Кожну колонку формату можна зіставити лише з одним заголовком файлу',
} as const

/** POST /org-structure/import/:id/mapping — сопоставление колонок и опции, повторная проверка тех же строк. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'org.structure.import')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', MESSAGE.not_found)
  const p = orgImportRemapSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'mapping_invalid', MESSAGE.mapping_invalid, { issues: p.error.issues })
  const r = await remapOrgImport({ tenantId: a.tenantId, actorId: a.userId }, id.data, p.data)
  if (!r.ok) return apiError(event, STATUS[r.code], r.code, MESSAGE[r.code])
  return apiData(r.view)
})
