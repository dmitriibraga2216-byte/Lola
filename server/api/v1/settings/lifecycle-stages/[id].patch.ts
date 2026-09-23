import { lifecycleStagePatchSchema } from '../../../../../shared/schemas/lifecycle'
import { requireScope } from '../../../../services/access'
import { updateStage } from '../../../../services/lifecycle'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * PATCH /settings/lifecycle-stages/:id — правка этапа тенантом (docs/v2/33 §5.2, §10).
 *
 * Порядок ответов важен и проверяется тестами:
 * 1. неизвестный ключ `capabilities` (или `code` в теле) — `422 validation_failed`
 *    (docs/v2/44 В-3: ключ отвергается, а не игнорируется);
 * 2. валидные `capabilities` от тенанта — `403 capabilities.readonly`: набор возможностей
 *    задаёт оператор платформы (`33` §2);
 * 3. выключение этапа с курсами — `409 lifecycle_stage.in_use` (`33` §5.2).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'lifecycle.manage')
  const id = getRouterParam(event, 'id')!
  const p = lifecycleStagePatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте значення етапу', { issues: p.error.issues })
  const r = await updateStage({ tenantId: a.tenantId, actorId: a.userId }, id, p.data)
  if (r === 'not_found') return apiError(event, 404, 'not_found', 'Етап не знайдено')
  if (r === 'capabilities_readonly') return apiError(event, 403, 'capabilities.readonly', 'Набір можливостей етапу задає платформа. Щоб змінити — зверніться до підтримки')
  if (r === 'stage_in_use') return apiError(event, 409, 'lifecycle_stage.in_use', 'В етапі є курси — перенесіть їх перед вимкненням')
  return apiData(r)
})
