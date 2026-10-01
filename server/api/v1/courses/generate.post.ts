import { requireScope, can } from '../../../services/access'
import { libraryActorOf } from '../../../services/library'
import { generateTrack } from '../../../services/trackAi'
import { trackGenerateSchema } from '../../../../shared/schemas/content'
import { apiData, apiError } from '../../../utils/apiResponse'
import { aiProviderFail, aiUnavailableFail } from '../../../utils/aiErrors'

const FAIL: Record<string, readonly [number, string, string]> = {
  stage_not_found: [404, 'not_found', 'Етап не знайдено'],
  stage_disabled: [422, 'lifecycle.disabled', 'Етап вимкнено в налаштуваннях — оберіть інший'],
  stage_ai_forbidden: [422, 'lifecycle.ai_generate_forbidden', 'Для цього етапу генерацію вимкнено: зберіть трек вручну або оберіть інший етап'],
  no_modules: [422, 'track.no_modules', 'У бібліотеці немає опублікованих модулів, з яких можна зібрати трек. Опублікуйте модулі або створіть курс вручну'],
  empty_plan: [422, 'track.empty_plan', 'ШІ не підібрав жодного модуля під цю мету. Уточніть мету або виберіть модулі самі'],
}

/**
 * POST /courses/generate — «Згенерувати трек» (`docs/v2/35` §7.1, §7.7 п. 4, к. 4; `44` Р-BT.3).
 *
 * Создаёт **черновик** курса из опубликованных модулей библиотеки тенанта; публикует человек.
 * Права — те же, что у ручной сборки: `course.create` (курс) и `course.edit` (уроки-вставки).
 * Модель — через шлюз: `409 ai.unavailable` при истёкшем ИИ, `409 limit_exceeded` с
 * `details.axis = 'ai_generate_ops'`, `503 ai.provider_failed`. `201` — `{courseId, …}`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'course.create')
  if (!can(a, 'course.edit')) return apiError(event, 403, 'forbidden', 'Немає права редагувати курси — зверніться до адміністратора')
  const p = trackGenerateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля', { issues: p.error.issues })
  if (p.data.lifecycleStageId && !can(a, 'lifecycle.manage')) return apiError(event, 403, 'forbidden', 'Етап курсу призначає адміністратор етапів — залиште етап порожнім')
  const r = await generateTrack(libraryActorOf(a), p.data)
  if (r.ok) {
    setResponseStatus(event, 201)
    return apiData({ courseId: r.courseId, title: r.title, sections: r.sections, lessons: r.lessons, aiCallId: r.aiCallId })
  }
  if (r.code === 'ai_unavailable') return aiUnavailableFail(event, r.reason)
  if (r.code === 'provider_failed') return aiProviderFail(event, r.reason)
  if (r.code === 'limit_exceeded') return apiError(event, 409, 'limit_exceeded', 'Ліміт ШІ-операцій вичерпано. Зберіть трек вручну або збільште ліміт у «Налаштування → Тариф»', { axis: r.check.axis, used: r.check.used, limit: r.check.limit })
  const [status, code, text] = FAIL[r.code]!
  return apiError(event, status, code, text)
})
