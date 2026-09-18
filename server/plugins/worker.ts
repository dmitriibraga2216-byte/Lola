import { getBoss } from '../services/queue'
import { processMedia, type MediaProcessJob } from '../jobs/mediaProcess'
import { expireStaleAttempts, tenantsWithActiveAttempts } from '../services/attempts'

/**
 * Воркер фоновых задач внутри процесса приложения (dev и старт).
 * На проде выносится в отдельный контейнер `worker` (docs/26 §26.4) —
 * этот плагин выключается переменной WORKER_ENABLED=0.
 */
export default defineNitroPlugin(async () => {
  if (process.env.WORKER_ENABLED === '0') return

  try {
    const boss = await getBoss()
    await boss.work<MediaProcessJob>('media.process', async (jobs) => {
      const job = jobs[0]
      if (job) await processMedia(job.data)
    })
    await boss.work('attempt.expire', async () => {
      for (const tenantId of await tenantsWithActiveAttempts()) {
        const n = await expireStaleAttempts(tenantId)
        if (n) console.log(`[attempt.expire] ${tenantId}: закрыто ${n}`)
      }
    })
  }
  catch (err) {
    console.error('Воркер не стартовал (очередь недоступна):', err)
  }
})
