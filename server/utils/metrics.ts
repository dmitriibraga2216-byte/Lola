import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * Метрики Prometheus (docs/06 §6.7, docs/26 §26.9): RED по HTTP, очередь и задачи, бизнес-события.
 * Один реестр на процесс; /metrics закрыт токеном METRICS_TOKEN (или открыт только с localhost).
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry, prefix: 'lola_' })

export const httpRequests = new Counter({ name: 'lola_http_requests_total', help: 'HTTP-запросы', labelNames: ['method', 'route', 'status'] as const, registers: [registry] })
export const httpDuration = new Histogram({ name: 'lola_http_request_duration_seconds', help: 'Длительность HTTP-запросов', labelNames: ['method', 'route'] as const, buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry] })
export const jobRuns = new Counter({ name: 'lola_jobs_total', help: 'Запуски фоновых задач', labelNames: ['job', 'result'] as const, registers: [registry] })
export const jobDuration = new Histogram({ name: 'lola_job_duration_seconds', help: 'Длительность задач', labelNames: ['job'] as const, buckets: [0.1, 0.5, 1, 5, 15, 60, 300], registers: [registry] })
export const queueDepth = new Gauge({ name: 'lola_queue_depth', help: 'Глубина очереди pg-boss (created + retry)', labelNames: ['queue'] as const, registers: [registry] })
export const business = new Counter({ name: 'lola_business_events_total', help: 'Бизнес-события: attempt_started, course_completed, notification_sent, notification_failed, telegram_error', labelNames: ['event'] as const, registers: [registry] })
export const dbPool = new Gauge({ name: 'lola_db_pool', help: 'Пул БД', labelNames: ['state'] as const, registers: [registry] })

/** Схлопывает путь до шаблона: uuid и числа → :id, чтобы не плодить лейблы. */
export function routeLabel(path: string): string {
  return path.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').replace(/\/c\/[A-Za-z0-9_-]{20,}/, '/c/:token').slice(0, 120)
}

/** Обёртка для задач воркера: считает длительность и результат. */
export async function timedJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const end = jobDuration.startTimer({ job })
  try { const r = await fn(); jobRuns.inc({ job, result: 'ok' }); return r }
  catch (e) { jobRuns.inc({ job, result: 'failed' }); throw e }
  finally { end() }
}
