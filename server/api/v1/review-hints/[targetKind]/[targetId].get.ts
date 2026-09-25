import { z } from 'zod'
import { AI_REVIEW_HINT_TARGETS } from '../../../../../shared/enums'
import { can, requireScope } from '../../../../services/access'
import { getReviewHint } from '../../../../services/reviewHints'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /review-hints/:targetKind/:targetId — «Підказка ШІ» в карточке проверки (`docs/v2/30` §5.5,
 * §7.13, §10; `ai.review.use`). Раскрытие ставит `shown_at`. Подсказка — три списка без вердикта:
 * ни балла, ни «зараховано», ни значений для формы ментора. Нет подсказки — `404 hint.absent`,
 * ось ИИ исчерпана или ИИ не действует — `409 hint.degraded` (работа — обычной ручной проверкой).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'ai.review.use')
  const kind = z.enum(AI_REVIEW_HINT_TARGETS).safeParse(getRouterParam(event, 'targetKind'))
  const id = z.string().uuid().safeParse(getRouterParam(event, 'targetId'))
  if (!kind.success || !id.success) return apiError(event, 404, 'hint.absent', 'Підказку не сформовано, перевірте відповідь самостійно')
  const r = await getReviewHint({ tenantId: a.tenantId, actorId: a.userId }, kind.data, id.data, { admin: can(a, 'ai.audit') })
  if (r.ok) return apiData(r.hint)
  if (r.code === 'degraded') return apiError(event, 409, 'hint.degraded', 'Підказку не сформовано: ліміт ШІ вичерпано або ШІ вимкнено. Перевірте відповідь самостійно')
  if (r.code === 'forbidden') return apiError(event, 403, 'forbidden', 'Цю роботу зараз перевіряє інша людина')
  return apiError(event, 404, 'hint.absent', 'Підказку не сформовано, перевірте відповідь самостійно')
})
