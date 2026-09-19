import { getBoss } from '../services/queue'
import { timedJob } from '../utils/metrics'
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
    // Каждая задача — с метриками длительности и результата (docs/06 §6.7)
    const work = <T = object>(name: string, fn: (jobs: { data: T }[]) => Promise<unknown>) =>
      boss.work<T>(name, jobs => timedJob(name, () => fn(jobs as { data: T }[])))
    await work<MediaProcessJob>('media.process', async (jobs) => {
      const job = jobs[0]
      if (job) await processMedia(job.data)
    })
    // PDF сертификата (docs/14 §7.5) — фоном после выдачи
    await work<{ tenantId: string, certificateId: string }>('certificate.render_pdf', async (jobs) => {
      const { renderAndStore } = await import('../services/certificatePdf')
      for (const j of jobs) await renderAndStore(j.data.tenantId, j.data.certificateId)
    })
    await work('attempt.expire', async () => {
      for (const tenantId of await tenantsWithActiveAttempts()) {
        const n = await expireStaleAttempts(tenantId)
        if (n) console.log(`[attempt.expire] ${tenantId}: закрыто ${n}`)
      }
    })
    await work('notification.dispatch', async () => {
      for (const tenantId of await tenantsWithQueued()) {
        const s = await dispatchNotifications(tenantId)
        if (s.sent || s.failed) console.log(`[notification.dispatch] ${tenantId}:`, s)
      }
    })
    await work('due.scan', async () => {
      const { goalDueScan } = await import('../services/development')
      const { assessmentScan } = await import('../services/assessment')
      const { actionDueScan, frequencyScan } = await import('../services/checklists')
      const { announcementScan } = await import('../services/news')
      const { programScan } = await import('../services/programs')
      const { inactiveScan } = await import('../services/people')
      const monday = new Date().getDay() === 1
      for (const tenantId of await allActiveTenants()) {
        const s = await runDueScan(tenantId)
        const inactive = await inactiveScan(tenantId) // docs/16 §11 people.inactive_scan
        const g = await goalDueScan(tenantId)
        const a = await assessmentScan(tenantId)
        const ai = await actionDueScan(tenantId)
        const cf = monday ? await frequencyScan(tenantId) : 0
        const an = await announcementScan(tenantId)
        const pr = await programScan(tenantId)
        console.log(`[due.scan] ${tenantId}:`, { ...s, goals: g, assessment: a, actionsOverdue: ai, checklistDue: cf, announcements: an, programs: pr, inactive })
      }
    })
    // Сводные отчёты по расписанию (docs/03 §3.26) — проверка раз в час вместе с assignment.sync
    await work('assignment.sync', async () => {
      const { scheduledReportsScan } = await import('../services/reportBuilder')
      const { recalcGroups } = await import('../services/groups')
      for (const tenantId of await allActiveTenants()) {
        const n = await scheduledReportsScan(tenantId)
        if (n) console.log(`[report.scheduled] ${tenantId}: ${n}`)
        const g = await recalcGroups(tenantId) // docs/16 §11 groups.recalc — до раскрытия аудиторий
        if (g) console.log(`[groups.recalc] ${tenantId}: ${g}`)
      }
      for (const tenantId of await allActiveTenants()) {
        const n = await syncAssignments(tenantId)
        if (n) console.log(`[assignment.sync] ${tenantId}: +${n}`)
      }
    })
    // Занятия (docs/18 §11): статусы planned→ongoing→finished, неявки, напоминания за сутки/час
    await work('meetup.scan', async () => {
      const { reminderScan, statusScan } = await import('../services/meetups')
      for (const tenantId of await allActiveTenants()) {
        const s = await statusScan(tenantId)
        const r = await reminderScan(tenantId)
        if (s.started || s.finished || r) console.log(`[meetup.scan] ${tenantId}:`, { ...s, reminded: r })
      }
    })
    await work('workshop.sla_scan', async () => {
      for (const tenantId of await allActiveTenants()) {
        const s = await workshopSlaScan(tenantId)
        if (s.released || s.breached || s.expired) console.log(`[workshop.sla_scan] ${tenantId}:`, s)
      }
    })
    await work('webhook.deliver', async () => {
      for (const tenantId of await tenantsWithPendingWebhooks()) {
        const s = await deliverPending(tenantId)
        if (s.delivered || s.failed) console.log(`[webhook.deliver] ${tenantId}:`, s)
      }
    })
    await work<{ tenantId: string, assignmentId: string }>('assignment.expand', async (jobs) => {
      const job = jobs[0]
      if (job) await expandAssignment(job.data.tenantId, job.data.assignmentId)
    })
  }
  catch (err) {
    console.error('Воркер не стартовал (очередь недоступна):', err)
  }
})
