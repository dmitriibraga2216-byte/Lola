import { z } from 'zod'
import { guestPage, slugFromHost } from '../../../services/hubExtra'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * GET /public/guest-page — что видит гость до входа (docs/21 §14.6, Г-21.3; docs/25 §4).
 * Тенант — из middleware `01.host` (TENANT_HOST_BASE, docs/25 §16.1), иначе по поддомену Host, в dev — `?slug=`.
 * Неизвестный — 404 без подробностей.
 */
export default defineEventHandler(async (event) => {
  const q = z.object({ slug: z.string().max(40).optional() }).safeParse(getQuery(event))
  const hostTenant = event.context.hostTenant as { slug: string } | undefined
  const slug = hostTenant?.slug ?? slugFromHost(getHeader(event, 'host')) ?? (q.success ? q.data.slug : undefined)
  const r = slug ? await guestPage(slug) : null
  if (!r) return apiError(event, 404, 'not_found', 'Простір не знайдено')
  return apiData(r)
})
