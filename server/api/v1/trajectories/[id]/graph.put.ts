import { trajectoryGraphSchema } from '../../../../../shared/schemas/trajectories'
import { can, requireScope } from '../../../../services/access'
import { putGraph } from '../../../../services/trajectories'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { libraryFail } from '../../../../utils/libraryErrors'
/**
 * Полотно целиком (docs/04 §4.10): узлы и связи; в ответе — сохранённый граф и список проблем.
 * Задание с `libraryModuleId` — модуль из палитры «Бібліотека модулів ▸» (docs/v2/31 §5.4): его
 * вставка требует ещё и `library.use`; отказ вставки откатывает всё сохранение и отвечает кодом
 * библиотеки (`409 module_archived`, `409 module_not_published`, …) с `details.nodeRef`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'program.manage')
  const p = trajectoryGraphSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте блоки', { issues: p.error.issues })
  const r = await putGraph({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'id')!, p.data, { libraryUse: can(a, 'library.use') })
  if (!r.ok) {
    if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Траєкторію не знайдено')
    if (r.code === 'published') return apiError(event, 409, 'trajectory.published', 'Опубліковану траєкторію не можна перебудувати — створіть копію і опублікуйте її')
    if (r.code === 'library') {
      if (r.libraryCode === 'forbidden') return libraryFail(event, 'forbidden', { nodeRef: r.nodeRef, reason: 'library_use' }, 'Вставляти модулі бібліотеки може лише той, у кого є право на бібліотеку')
      return libraryFail(event, r.libraryCode, { nodeRef: r.nodeRef })
    }
    return apiError(event, 422, 'trajectory.bad_edge', r.message ?? 'Перевірте звʼязки')
  }
  return apiData(r)
})
