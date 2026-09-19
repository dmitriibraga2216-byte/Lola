import { randomUUID } from 'node:crypto'
import { httpDuration, httpRequests, routeLabel } from '../utils/metrics'
import { registerEventAccessor, requestContextOf } from '../utils/requestContext'

// Nitro experimental.asyncContext: useEvent() доступен в любом сервисе внутри запроса
registerEventAccessor(() => { try { return useEvent() } catch { return undefined } })

/**
 * trace_id на каждый запрос (docs/06 §6.7): берём X-Request-Id от прокси или генерируем,
 * отдаём в ответе, кладём в event.context для логов и Sentry; здесь же RED-метрики.
 */
export default defineEventHandler(async (event) => {
  const traceId = (getHeader(event, 'x-request-id') || randomUUID()).slice(0, 64)
  event.context.traceId = traceId
  setHeader(event, 'x-request-id', traceId)
  // Технический контекст события (CLAUDE.md п. 14) — один на запрос, доступен сервисам через currentRequestContext()
  event.context.requestContext = await requestContextOf(event)
  if (!event.path.startsWith('/api/') && !event.path.startsWith('/c/') && !event.path.startsWith('/tg/')) return
  const started = process.hrtime.bigint()
  const method = event.method
  const route = routeLabel(event.path)
  event.node.res.once('finish', () => {
    const sec = Number(process.hrtime.bigint() - started) / 1e9
    httpRequests.inc({ method, route, status: String(event.node.res.statusCode) })
    httpDuration.observe({ method, route }, sec)
  })
})
