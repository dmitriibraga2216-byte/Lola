import type { NitroErrorHandler } from 'nitropack'
import { randomUUID } from 'node:crypto'

/**
 * Единый формат ошибок API (docs/04-api.md §4.1): { error: { code, message, details? } }.
 * createError({ data: { code, message } }) из requireScope и т.п. приводится к нему;
 * непредвиденные ошибки — 500 с trace_id, без stack наружу.
 */
const handler: NitroErrorHandler = (error, event) => {
  const status = error.statusCode || 500
  const data = (error.data ?? {}) as { code?: string, message?: string, details?: Record<string, unknown> }

  if (!event.path.startsWith('/api/')) {
    event.node.res.statusCode = status
    event.node.res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    event.node.res.end(status === 404 ? 'Not found' : 'Error')
    return
  }

  let body: Record<string, unknown>
  if (status >= 500) {
    const traceId = randomUUID()
    console.error(`[${traceId}]`, error)
    body = { error: { code: 'internal', message: 'Щось пішло не так', details: { traceId } } }
  }
  else {
    body = {
      error: {
        code: data.code ?? (status === 404 ? 'not_found' : status === 401 ? 'auth_required' : status === 403 ? 'forbidden' : 'error'),
        message: data.message ?? error.message ?? '',
        ...(data.details ? { details: data.details } : {}),
      },
    }
  }

  event.node.res.statusCode = status
  event.node.res.setHeader('Content-Type', 'application/json; charset=utf-8')
  event.node.res.end(JSON.stringify(body))
}

export default handler
