import * as Sentry from '@sentry/node'

/** Sentry для сервера (docs/06 §6.7): только при SENTRY_DSN; trace_id и tenant_id идут тегами из error handler. */
export default defineNitroPlugin(() => {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? 'production', release: process.env.APP_VERSION || undefined, tracesSampleRate: 0 })
  console.log('[sentry] увімкнено')
})
