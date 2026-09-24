import { libraryAttachSchema } from '../../../../../shared/schemas/library'
import { requireScope } from '../../../../services/access'
import { libraryActorOf } from '../../../../services/library'
import { attachUsage } from '../../../../services/libraryUsages'
import { apiData } from '../../../../utils/apiResponse'
import { libraryFail, libraryValidationFail } from '../../../../utils/libraryErrors'

/**
 * POST /library/usages — вставить модуль в узел трека или урок курса (docs/v2/31 §5.4, §7.1,
 * §7.2, §10). Закрепляется версия, текущая на момент вставки. Без права на контейнер —
 * `403 container.forbidden`; архивный модуль — `409 module_archived`; держатель уже с
 * модулем — `409 already_attached`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'library.use')
  const p = libraryAttachSchema.safeParse(await readBody(event))
  if (!p.success) return libraryValidationFail(event, p.error)
  const r = await attachUsage(libraryActorOf(a), p.data)
  if (!r.ok) return libraryFail(event, r.code)
  return apiData(r.usage)
})
