import { z } from 'zod'
import { guestPage, slugFromHost } from '../../../services/hubExtra'
import { hitRateLimit } from '../../../services/rateLimit'
import { apiData, apiError } from '../../../utils/apiResponse'
import { clientIp } from '../../../utils/authCookies'

/**
 * GET /public/guest-page — что видит гость до входа (docs/21 §14.6, Г-21.3; docs/25 §4).
 * Тенант — из middleware `01.host` (TENANT_HOST_BASE, docs/25 §16.1), иначе по поддомену Host, в dev — `?slug=`.
 * Неизвестный — 404 без подробностей.
 *
 * Частотное ограничение — решение docs/v2/44 В-9 п. 3: правило публичного контура требует
 * `hitRateLimit` у каждой ручки под `public/`. Здесь оно мешает перебирать поддомены и
 * собирать список существующих пространств — 404 без подробностей сам по себе этого не
 * мешает, если спрашивать можно бесконечно.
 */
const VIEW_LIMIT = 60
const VIEW_WINDOW_SEC = 600

export default defineEventHandler(async (event) => {
  if (!await hitRateLimit(`guest-page:${clientIp(event)}`, VIEW_LIMIT, VIEW_WINDOW_SEC)) {
    setResponseHeader(event, 'Retry-After', VIEW_WINDOW_SEC)
    return apiError(event, 429, 'rate.too_many', 'Забагато запитів. Спробуйте за кілька хвилин')
  }
  const q = z.object({ slug: z.string().max(40).optional() }).safeParse(getQuery(event))
  const hostTenant = event.context.hostTenant as { slug: string } | undefined
  const slug = hostTenant?.slug ?? slugFromHost(getHeader(event, 'host')) ?? (q.success ? q.data.slug : undefined)
  const r = slug ? await guestPage(slug) : null
  if (!r) return apiError(event, 404, 'not_found', 'Простір не знайдено')
  return apiData(r)
})
