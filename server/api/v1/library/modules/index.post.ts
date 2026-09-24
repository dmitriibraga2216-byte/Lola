import { libraryModuleCreateSchema } from '../../../../../shared/schemas/library'
import { requireScope } from '../../../../services/access'
import { createModule, libraryActorOf } from '../../../../services/library'
import { apiData } from '../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../utils/libraryErrors'

/**
 * POST /library/modules — «Створити модуль» (docs/v2/31 §6.1, §10). Класть в библиотеку —
 * только `library.publish` (Р-31.6): носитель `library.use` без него подаёт предложение
 * (`POST /library/proposals`), модуль при этом не создаётся (критерий приёмки 5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.publish')
  const p = libraryModuleCreateSchema.safeParse(await readBody(event))
  if (!p.success) return libraryValidationFail(event, p.error, 'Перевірте поля модуля')
  const r = await createModule(libraryActorOf(a), p.data)
  if (!r.ok) return libraryFail(event, r.code)
  return apiData(r.module)
})
