import { libraryModuleUpdateSchema } from '../../../../../../shared/schemas/library'
import { requireAnyScope } from '../../../../../services/access'
import { libraryActorOf, updateModule } from '../../../../../services/library'
import { apiData } from '../../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../../utils/libraryErrors'

/**
 * PATCH /library/modules/:id — правка карточки и черновика (docs/v2/31 §6.1, §7.12, §10).
 * Чужой модуль без `library.manage` — `403 forbidden` с подсказкой «Зверніться до власника
 * модуля»; архивный — `409 module_archived`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, ['library.publish', 'library.manage'])
  const p = libraryModuleUpdateSchema.safeParse(await readBody(event))
  if (!p.success) return libraryValidationFail(event, p.error, 'Перевірте поля модуля')
  const r = await updateModule(libraryActorOf(a), getRouterParam(event, 'id')!, p.data)
  if (!r.ok) return libraryFail(event, r.code, r.code === 'forbidden' ? { reason: 'not_author' } : undefined)
  return apiData(r.module)
})
