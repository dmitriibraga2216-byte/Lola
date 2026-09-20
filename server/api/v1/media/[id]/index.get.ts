import { requireScope } from '../../../../services/access'
import { getMedia, signedReadUrl } from '../../../../services/media'
import { apiData, apiError } from '../../../../utils/apiResponse'

/** Статус и подписанные ссылки на 10 минут (docs/04 §4.9). */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const media = await getMedia(
    { tenantId: access.tenantId, actorId: access.userId },
    getRouterParam(event, 'id')!,
  )
  if (!media || media.deletedAt) return apiError(event, 404, 'not_found', 'Файл не знайдено')

  const variants = media.variants as Record<string, string>
  // D-011: оригинал SVG доступен только после обработки (санитизации) — до неё ссылки на него нет
  const originalReady = media.mime !== 'image/svg+xml' || media.status === 'ready'
  // ?redirect=1 — для <img src>: 302 на подписанную ссылку (фото чек-листов, подпись)
  if (getQuery(event).redirect) {
    const key = (getQuery(event).variant && variants[String(getQuery(event).variant)]) || (originalReady ? media.key : null)
    if (!key) return apiError(event, 409, 'not_ready', 'Файл ще обробляється')
    return sendRedirect(event, await signedReadUrl(key), 302)
  }
  const urls: Record<string, string> = originalReady ? { original: await signedReadUrl(media.key) } : {}
  for (const [w, key] of Object.entries(variants)) if (typeof key === 'string') urls[w] = await signedReadUrl(key)
  if (media.posterKey) urls.poster = await signedReadUrl(media.posterKey)

  return apiData({
    id: media.id,
    kind: media.kind,
    mime: media.mime,
    status: media.status,
    width: media.width,
    height: media.height,
    originalName: media.originalName,
    urls,
  })
})
