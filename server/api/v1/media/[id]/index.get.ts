import { requireScope } from '../../../../services/access'
import { getMedia, noteMediaAccess, signedReadUrl } from '../../../../services/media'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * Статус и подписанные ссылки (docs/04 §4.9): 10 минут обычному файлу и **120 секунд**
 * файлу-доказательству (решение docs/v2/44 В-19). Выдача ссылки на доказательство пишется
 * в `audit_log` событием `media.download` — только для `is_evidence = true`: обложка курса
 * скачивается при каждом открытии урока, журналировать её значит утопить в шуме ответ на
 * вопрос «кто снёс доказательства за прошлый квартал» (`34` §9).
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'learn.view')
  const ctx = { tenantId: access.tenantId, actorId: access.userId }
  const media = await getMedia(ctx, getRouterParam(event, 'id')!)
  if (!media || media.deletedAt) return apiError(event, 404, 'not_found', 'Файл не знайдено')

  const variants = media.variants as Record<string, string>
  // D-011: оригинал SVG доступен только после обработки (санитизации) — до неё ссылки на него нет
  const originalReady = media.mime !== 'image/svg+xml' || media.status === 'ready'
  // ?redirect=1 — для <img src>: 302 на подписанную ссылку (фото чек-листов, подпись)
  if (getQuery(event).redirect) {
    const key = (getQuery(event).variant && variants[String(getQuery(event).variant)]) || (originalReady ? media.key : null)
    if (!key) return apiError(event, 409, 'not_ready', 'Файл ще обробляється')
    await noteMediaAccess(ctx, media)
    return sendRedirect(event, await signedReadUrl(key, media.isEvidence), 302)
  }
  await noteMediaAccess(ctx, media)
  const urls: Record<string, string> = originalReady ? { original: await signedReadUrl(media.key, media.isEvidence) } : {}
  for (const [w, key] of Object.entries(variants)) if (typeof key === 'string') urls[w] = await signedReadUrl(key, media.isEvidence)
  if (media.posterKey) urls.poster = await signedReadUrl(media.posterKey, media.isEvidence)

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
