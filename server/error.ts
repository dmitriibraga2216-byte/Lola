import type { NitroErrorHandler } from 'nitropack'
import { randomUUID } from 'node:crypto'
import * as Sentry from '@sentry/node'

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
    const traceId = (event.context.traceId as string | undefined) ?? randomUUID()
    const auth = event.context.auth as { tenantId?: string, userId?: string } | undefined
    // Структурный лог с trace_id/tenant_id/user_id (docs/06 §6.7)
    console.error(JSON.stringify({ level: 'error', trace_id: traceId, tenant_id: auth?.tenantId ?? null, user_id: auth?.userId ?? null, path: event.path, message: error.message, stack: error.stack?.split('\n').slice(0, 6).join(' | ') }))
    if (process.env.SENTRY_DSN) Sentry.captureException(error, { tags: { trace_id: traceId, tenant_id: auth?.tenantId ?? 'none' }, user: auth?.userId ? { id: auth.userId } : undefined })
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
