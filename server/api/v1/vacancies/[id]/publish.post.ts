import { requireScope } from '../../../../services/access'
import { publishVacancy, viewerOf } from '../../../../services/vacancies'
import { enqueueSubscriberNotify } from '../../../../services/queue'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/publish — публикация (docs/v2/29 §4, §7.1, §7.9, §10).
 *
 * `422 vacancy.link_requirements` — нет курса, точки, рекрутера или названия: ссылка без
 * назначаемого курса это отклик, который некуда девать (критерий §13 к. 1; то же правило
 * стоит констрейнтом `vacancies_public_chk`).
 * `409 vacancy.ai_text_unreviewed` — в тексте есть непроверенный блок ИИ (§7.9).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'vacancy.publish')
  const r = await publishVacancy(viewerOf(a), getRouterParam(event, 'id')!)
  if (r.ok) {
    // Набор возобновлён после паузы — письма тем, кто нажал «Повідомити, коли відкриється» (§5.6, §11).
    if (r.resumed) await enqueueSubscriberNotify(a.tenantId, r.vacancy.id).catch(err => console.error('[vacancy.subscriber_notify] enqueue', err))
    return apiData(r.vacancy)
  }
  switch (r.code) {
    case 'not_found':
      return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
    case 'link_requirements':
      return apiError(event, 422, 'vacancy.link_requirements', 'Оберіть курс і точку, щоб створити посилання на автоматичний відбір', { missing: r.missing })
    case 'ai_text_unreviewed':
      return apiError(event, 409, 'vacancy.ai_text_unreviewed', 'Перевірте згенерований текст перед публікацією', { blocks: r.blocks })
    case 'reopen_expired':
      return apiError(event, 409, 'vacancy.reopen_expired', 'Вакансію закрито понад 90 днів тому: створіть нову')
    default:
      return apiError(event, 409, 'vacancy.wrong_state', 'Вакансію не можна опублікувати з цього стану')
  }
})
