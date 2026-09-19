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
  // ?redirect=1 — для <img src>: 302 на подписанную ссылку (фото чек-листов, подпись)
  if (getQuery(event).redirect) return sendRedirect(event, await signedReadUrl((getQuery(event).variant && variants[String(getQuery(event).variant)]) || media.key), 302)
  const urls: Record<string, string> = { original: await signedReadUrl(media.key) }
  for (const [w, key] of Object.entries(variants)) urls[w] = await signedReadUrl(key)
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
