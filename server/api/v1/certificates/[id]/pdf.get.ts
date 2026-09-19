import { requireScope, can } from '../../../../services/access'
import { pdfUrl } from '../../../../services/certificatePdf'
import { apiError } from '../../../../utils/apiResponse'
/** «Завантажити PDF» (docs/14 §5.4): подписанная ссылка на S3; отозванный не отдаётся. */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const id = getRouterParam(event, 'id') ?? ''
  if (!/^[0-9a-f-]{36}$/.test(id)) return apiError(event, 404, 'not_found', 'Сертифікат не знайдено')
  const r = await pdfUrl({ tenantId: a.tenantId, actorId: a.userId }, id, { manage: can(a, 'certification.confirm') || can(a, 'report.team') })
  if ('error' in r) {
    const map: Record<string, [number, string]> = { not_found: [404, 'Сертифікат не знайдено'], revoked: [410, 'Сертифікат відкликано'], forbidden: [403, 'Це не ваш сертифікат'], not_ready: [503, 'PDF ще готується'] }
    const [st, msg] = map[r.error]!
    return apiError(event, st, `certificate.${r.error}`, msg)
  }
  return sendRedirect(event, r.url, 302)
})
