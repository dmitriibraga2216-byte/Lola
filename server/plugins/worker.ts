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
    await work<{ tenantId: string, exportId: string }>('report.export', async (jobs) => {
      const { runExport } = await import('../services/reportExports')
      for (const j of jobs) await runExport(j.data.exportId, j.data.tenantId)
    })
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
    await work('usage.collect', async () => {
      const { collectUsageDue } = await import('../services/usage')
      const n = await collectUsageDue()
      if (n) console.log(`[usage.collect] собрано: ${n}`)
    })
    await work('due.scan', async () => {
      const { goalDueScan } = await import('../services/development')
      const { assessmentScan } = await import('../services/assessment')
      const { actionDueScan, frequencyScan } = await import('../services/checklists')
      const { noticeScan } = await import('../services/notices')
      const { birthdayScan } = await import('../services/hubPeople')
      const { programScan } = await import('../services/programs')
      const { inactiveScan } = await import('../services/people')
      const { planPeriodScan, requestReportScan } = await import('../services/developmentExtra')
      const { reviewScan } = await import('../services/knowledge')
      const { weeklyDigest } = await import('../services/reportsExtra')
      const { retentionScan } = await import('../services/logs')
      const { expireExports } = await import('../services/reportExports')
      const { expireRoles } = await import('../services/positionRoleMap')
      const monday = new Date().getDay() === 1
      for (const tenantId of await allActiveTenants()) {
        const s = await runDueScan(tenantId)
        const inactive = await inactiveScan(tenantId) // docs/16 §11 people.inactive_scan
        const plans = await planPeriodScan(tenantId) // docs/19 §7.6 plan.period_scan
        const reqReports = await requestReportScan(tenantId) // docs/19 §7.8 request.report_reminder
        const kbReview = await reviewScan(tenantId) // docs/21 §11 knowledge.review_scan
        const digest = monday ? await weeklyDigest(tenantId) : 0 // docs/22 §10 digest.weekly
        const retention = await retentionScan(tenantId) // docs/22 §10 logs.retention
        const expired = await expireExports(tenantId)
        const rolesExpired = await expireRoles(tenantId) // 29 Б.15: снятие роли по сроку
        const g = await goalDueScan(tenantId)
        const a = await assessmentScan(tenantId)
        const ai = await actionDueScan(tenantId)
        const cf = monday ? await frequencyScan(tenantId) : 0
        const an = await noticeScan(tenantId)
        const bd = await birthdayScan(tenantId)
        const pr = await programScan(tenantId)
        const { trajectoryScan } = await import('../services/trajectories')
        const tr = await trajectoryScan(tenantId) // docs/17: отложенные правилом прохождения, подстраховка таймеров
        console.log(`[due.scan] ${tenantId}:`, { ...s, goals: g, assessment: a, actionsOverdue: ai, checklistDue: cf, notices: an, birthdays: bd, programs: pr, trajectories: tr, inactive, plans, reqReports, kbReview, digest, retention, expiredExports: expired, rolesExpired })
      }
    })
    // Сводные отчёты по расписанию (docs/03 §3.26) — проверка раз в час вместе с assignment.sync
    await work('assignment.sync', async () => {
      const { scheduledReportsScan } = await import('../services/reportBuilder')
      const { recalcGroups } = await import('../services/groups')
      const { escalationScan } = await import('../services/notifications')
      const { telegramHealth } = await import('../services/telegram')
      await telegramHealth() // docs/23 §10 telegram.health
      for (const tenantId of await allActiveTenants()) {
        const n = await scheduledReportsScan(tenantId)
        if (n) console.log(`[report.scheduled] ${tenantId}: ${n}`)
        const g = await recalcGroups(tenantId) // docs/16 §11 groups.recalc — до раскрытия аудиторий
        const esc = await escalationScan(tenantId) // docs/23 §6.6 notification.escalate
        if (esc) console.log(`[notification.escalate] ${tenantId}: ${esc}`)
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
      const { publishScan } = await import('../services/news')
      for (const tenantId of await allActiveTenants()) { const p = await publishScan(tenantId); if (p.published || p.unpublished) console.log(`[news.publish_scan] ${tenantId}:`, p) } // docs/21 §11
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
    await work<{ tenantId: string, stateId: string }>('trajectory.timer', async (jobs) => {
      const { fireTimer } = await import('../services/trajectories')
      for (const j of jobs) await fireTimer(j.data.tenantId, j.data.stateId)
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
