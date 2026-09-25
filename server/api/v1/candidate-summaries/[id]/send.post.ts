import { candidateSummarySendSchema } from '../../../../../shared/schemas/candidateSummaries'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { sendSummary } from '../../../../services/candidateSummaries'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidate-summaries/:id/send — «Надіслати кандидату» (`email`) или «Скопіювати посилання»
 * (`link`) (`docs/v2/30` §5.4, §7.15, §10; `summary.send`). Ссылка живёт 30 дней; письмо уходит в
 * окне кандидата 09:00–20:00. Нанятому, обезличенному, отозвавшему согласие — не отправляется.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'summary.send')
  const p = candidateSummarySendSchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Оберіть спосіб надсилання', { issues: p.error.issues })
  const r = await sendSummary(viewerOf(a), getRouterParam(event, 'id')!, p.data.channel)
  if (r.ok) return apiData(r)
  if (r.code === 'contact_missing') return apiError(event, 422, 'contact.missing', 'У кандидата немає e-mail. Додайте його в картці або скопіюйте посилання й передайте іншим способом')
  if (r.code === 'consent_withdrawn') return apiError(event, 409, 'consent.withdrawn', 'Кандидат відкликав згоду — підсумок не надсилається')
  if (r.code === 'not_candidate') return apiError(event, 409, 'summary.not_candidate', 'Людина вже не кандидат (найнята або дані знеособлено) — підсумок не надсилається')
  if (r.code === 'not_latest') return apiError(event, 409, 'summary.not_latest', 'Це не остання версія підсумку. Надішліть останню')
  if (r.code === 'not_ready') return apiError(event, 409, 'summary.not_ready', 'Підсумок ще збирається, відкликаний або стертий')
  return apiError(event, 404, 'not_found', 'Підсумок не знайдено')
})
