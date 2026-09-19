import { registry, queueDepth, dbPool } from '../utils/metrics'
import { db } from '../db/client'
import { sql } from 'drizzle-orm'

/** Prometheus-метрики (docs/26 §26.9). Доступ: METRICS_TOKEN в Authorization: Bearer, без токена — только с localhost/сети docker. */
export default defineEventHandler(async (event) => {
  const token = process.env.METRICS_TOKEN
  const auth = getHeader(event, 'authorization') ?? ''
  const ip = (getHeader(event, 'x-forwarded-for') ?? event.node.req.socket.remoteAddress ?? '').split(',')[0]!.trim()
  const local = /^(127\.|::1|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)
  if (token ? auth !== `Bearer ${token}` : !local) throw createError({ statusCode: 403, message: 'forbidden' })

  try {
    // Очередь — через pg-boss (админское подключение): app_user не видит схему pgboss
    if (process.env.WORKER_ENABLED !== '0' || process.env.METRICS_QUEUE === '1') {
      const { getBoss } = await import('../services/queue')
      const boss = await getBoss()
      queueDepth.reset()
      for (const q of await boss.getQueues()) {
        const [st] = await boss.getQueueStats(q.name)
        if (st) queueDepth.set({ queue: q.name }, (st.queuedCount ?? 0) + (st.readyCount ?? 0))
      }
    }
    const [pool] = await db.execute(sql`select count(*) filter (where state = 'active')::int as active, count(*) filter (where state = 'idle')::int as idle from pg_stat_activity where datname = current_database()`) as unknown as { active: number, idle: number }[]
    if (pool) { dbPool.set({ state: 'active' }, pool.active); dbPool.set({ state: 'idle' }, pool.idle) }
  }
  catch { /* БД недоступна — отдаём то, что есть в памяти */ }
  setHeader(event, 'content-type', registry.contentType)
  return registry.metrics()
})
