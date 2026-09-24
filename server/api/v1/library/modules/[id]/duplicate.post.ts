import { libraryDuplicateSchema } from '../../../../../../shared/schemas/library'
import { requireScope } from '../../../../../services/access'
import { duplicateModule, libraryActorOf } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/** POST /library/modules/:id/duplicate `{title?}` — «Дублювати» (docs/v2/31 §5.2, §10): новый черновик, владелец — тот, кто копирует. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.publish')
  const p = libraryDuplicateSchema.safeParse((await readBody(event)) ?? {})
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await duplicateModule(libraryActorOf(a), getRouterParam(event, 'id')!, p.data.title)
  if (!r.ok) return libraryFail(event, r.code)
  return apiData(r.module)
})
