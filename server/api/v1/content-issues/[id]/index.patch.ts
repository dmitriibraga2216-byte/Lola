import { z } from 'zod'
import { requireScope } from '../../../../services/access'
import { updateIssue, viewerOf } from '../../../../services/contentIssueTriage'
import type { UpdateError } from '../../../../services/contentIssueTriage'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { contentIssuePatchSchema } from '../../../../../shared/schemas/contentIssues'

/**
 * PATCH /content-issues/:id — разбор (docs/v2/36 §4, §6.2, §10): переход статуса с резолюцией,
 * «Впливає на бали», внутренняя заметка. Каждый отказ объясняет, что сделать; при конфликте
 * (второй из двух одновременных разборов) в `details.card` — актуальная карточка (§12).
 */
const ERRORS: Record<UpdateError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Скаргу не знайдено'],
  invalid_transition: [409, 'content_issue.invalid_transition', 'Такий перехід статусу неможливий — оновіть картку, її вже змінили'],
  forbidden: [403, 'forbidden', 'Цю дію виконує адміністратор'],
  resolution_required: [400, 'content_issue.resolution_required', 'Вкажіть результат розгляду'],
  resolution_invalid: [400, 'validation_failed', 'Цей результат не підходить до скарги: «Питання виправлено» й «Питання анульовано» — лише для питання тесту'],
  comment_required: [400, 'validation_failed', 'Напишіть коментар для заявника — хоча б одне речення'],
  due_required: [400, 'validation_failed', 'Вкажіть термін — не пізніше ніж за 180 днів'],
  rescore_pending: [409, 'content_issue.invalid_transition', 'Спершу перерахуйте результати або відмовтеся від перерахунку з коментарем'],
  affects_scoring_invalid: [400, 'validation_failed', '«Впливає на бали» буває лише в тесту та питання'],
  duplicate_open: [409, 'content_issue.invalid_transition', 'На це місце вже є відкрита скарга — працюйте з нею'],
}

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'content_issue.triage')
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) return apiError(event, 404, 'not_found', 'Скаргу не знайдено')
  const p = contentIssuePatchSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте поля форми')
  const r = await updateIssue(await viewerOf(a), id.data, p.data)
  if (r.ok) return apiData(r.card)
  const [status, code, message] = ERRORS[r.code]
  return apiError(event, status, code, message, r.card ? { card: r.card } : undefined)
})
