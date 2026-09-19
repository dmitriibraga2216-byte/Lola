import { getBoss } from '../services/queue'
import { processMedia, type MediaProcessJob } from '../jobs/mediaProcess'
import { expireStaleAttempts, tenantsWithActiveAttempts } from '../services/attempts'
import { dispatchNotifications, tenantsWithQueued } from '../services/notifications'
import { allActiveTenants, runDueScan } from '../services/dueScan'
import { expandAssignment, syncAssignments } from '../services/assignments'
import { workshopSlaScan } from '../services/workshops'
import { deliverPending, tenantsWithPendingWebhooks } from '../services/webhooks'
import { ensureFirstAdmin } from '../services/platform'

/**
 * Воркер фоновых задач внутри процесса приложения (dev и старт).
 * На проде выносится в отдельный контейнер `worker` (docs/26 §26.4) —
 * этот плагин выключается переменной WORKER_ENABLED=0.
 */
export default defineNitroPlugin(async () => {
  if (process.env.WORKER_ENABLED === '0') return

  await ensureFirstAdmin().catch(err => console.error('ensureFirstAdmin', err))

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
    await boss.work('notification.dispatch', async () => {
      for (const tenantId of await tenantsWithQueued()) {
        const s = await dispatchNotifications(tenantId)
        if (s.sent || s.failed) console.log(`[notification.dispatch] ${tenantId}:`, s)
      }
    })
    await boss.work('due.scan', async () => {
      const { goalDueScan } = await import('../services/development')
      const { assessmentScan } = await import('../services/assessment')
      const { actionDueScan, frequencyScan } = await import('../services/checklists')
      const monday = new Date().getDay() === 1
      for (const tenantId of await allActiveTenants()) {
        const s = await runDueScan(tenantId)
        const g = await goalDueScan(tenantId)
        const a = await assessmentScan(tenantId)
        const ai = await actionDueScan(tenantId)
        const cf = monday ? await frequencyScan(tenantId) : 0
        console.log(`[due.scan] ${tenantId}:`, { ...s, goals: g, assessment: a, actionsOverdue: ai, checklistDue: cf })
      }
    })
    await boss.work('assignment.sync', async () => {
      for (const tenantId of await allActiveTenants()) {
        const n = await syncAssignments(tenantId)
        if (n) console.log(`[assignment.sync] ${tenantId}: +${n}`)
      }
    })
    // Занятия (docs/18 §11): статусы planned→ongoing→finished, неявки, напоминания за сутки/час
    await boss.work('meetup.scan', async () => {
      const { reminderScan, statusScan } = await import('../services/meetups')
      for (const tenantId of await allActiveTenants()) {
        const s = await statusScan(tenantId)
        const r = await reminderScan(tenantId)
        if (s.started || s.finished || r) console.log(`[meetup.scan] ${tenantId}:`, { ...s, reminded: r })
      }
    })
    await boss.work('workshop.sla_scan', async () => {
      for (const tenantId of await allActiveTenants()) {
        const s = await workshopSlaScan(tenantId)
        if (s.released || s.breached || s.expired) console.log(`[workshop.sla_scan] ${tenantId}:`, s)
      }
    })
    await boss.work('webhook.deliver', async () => {
      for (const tenantId of await tenantsWithPendingWebhooks()) {
        const s = await deliverPending(tenantId)
        if (s.delivered || s.failed) console.log(`[webhook.deliver] ${tenantId}:`, s)
      }
    })
    await boss.work<{ tenantId: string, assignmentId: string }>('assignment.expand', async (jobs) => {
      const job = jobs[0]
      if (job) await expandAssignment(job.data.tenantId, job.data.assignmentId)
    })
  }
  catch (err) {
    console.error('Воркер не стартовал (очередь недоступна):', err)
  }
})
