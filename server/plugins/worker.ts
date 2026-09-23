import { getBoss } from '../services/queue'
import { timedJob } from '../utils/metrics'
import { processMedia, type MediaProcessJob } from '../jobs/mediaProcess'
import { dueScanTenant } from '../jobs/dueScanTenant'
import { candidateAutoArchiveTenant, candidateConsentSweepTenant } from '../jobs/candidateScan'
import { expireStaleAttempts, tenantsWithActiveAttempts } from '../services/attempts'
import { dispatchNotifications, tenantsWithQueued } from '../services/notifications'
import { expandAssignment, syncAssignments } from '../services/assignments'
import { workshopSlaScan } from '../services/workshops'
import { deliverPending, tenantsWithPendingWebhooks } from '../services/webhooks'
import { ensureFirstAdmin } from '../services/platform'
import { recruitingTenantIds } from '../services/modules'
import { enqueueForTenant, runPerTenant, workByTenant } from '../services/tenantQueue'
import { activeTenantIds } from '../services/tenantResolve'

/**
 * Воркер фоновых задач внутри процесса приложения (dev и старт).
 * На проде выносится в отдельный контейнер `worker` (docs/26 §26.4) —
 * этот плагин выключается переменной WORKER_ENABLED=0.
 *
 * Изоляция по тенантам (docs/25 §5): задачи с сущностью несут `tenantId` и идут через `workByTenant`
 * (статус тенанта, лимит активных задач); сканы по расписанию раскладываются `runPerTenant` —
 * круг round-robin с квотой на тенанта, падение одного тенанта не трогает остальных, приостановленные пропускаются.
 * `due.scan` — планировщик: ставит `due.scan.tenant` на каждый работающий тенант.
 */
export default defineNitroPlugin(async () => {
  if (process.env.WORKER_ENABLED === '0') return

  await ensureFirstAdmin().catch(err => console.error('ensureFirstAdmin', err))

  try {
    const boss = await getBoss()
    // Каждая задача — с метриками длительности и результата (docs/06 §6.7)
    const work = <T = object>(name: string, fn: (jobs: { data: T }[]) => Promise<unknown>) =>
      boss.work<T>(name, jobs => timedJob(name, () => fn(jobs as { data: T }[])))
    const perTenant = <T extends { tenantId: string }>(name: string, fn: (data: T) => Promise<unknown>) =>
      workByTenant<T>(boss, name, fn, run => timedJob(name, run))

    await perTenant<MediaProcessJob>('media.process', data => processMedia(data))
    await perTenant<{ tenantId: string, exportId: string }>('report.export', async (data) => {
      const { runExport } = await import('../services/reportExports')
      await runExport(data.exportId, data.tenantId)
    })
    // PDF сертификата (docs/14 §7.5) — фоном после выдачи
    await perTenant<{ tenantId: string, certificateId: string }>('certificate.render_pdf', async (data) => {
      const { renderAndStore } = await import('../services/certificatePdf')
      await renderAndStore(data.tenantId, data.certificateId)
    })
    await perTenant<{ tenantId: string, stateId: string }>('trajectory.timer', async (data) => {
      const { fireTimer } = await import('../services/trajectories')
      await fireTimer(data.tenantId, data.stateId)
    })
    await perTenant<{ tenantId: string, assignmentId: string }>('assignment.expand', data => expandAssignment(data.tenantId, data.assignmentId))
    // Удаление тенанта через 30 дней после команды оператора (docs/25 §8); обработчик сам проверяет срок и статус
    await work<{ tenantId: string }>('tenant.purge', async (jobs) => {
      const { runTenantPurge } = await import('../services/platformTenants')
      for (const j of jobs) {
        const r = await runTenantPurge(j.data.tenantId)
        console.log(`[tenant.purge] ${j.data.tenantId}:`, r.purged ? r.report : r.reason)
      }
    })

    await work('attempt.expire', () => runPerTenant('attempt.expire', async (tenantId) => {
      const n = await expireStaleAttempts(tenantId)
      if (n) console.log(`[attempt.expire] ${tenantId}: закрыто ${n}`)
    }, tenantsWithActiveAttempts))
    // docs/25 §14 п. 8: квота на тенанта за круг — 5000 уведомлений одного не задерживают 5 другого
    await work('notification.dispatch', () => runPerTenant('notification.dispatch', async (tenantId, quota) => {
      const s = await dispatchNotifications(tenantId, quota)
      if (s.sent || s.failed) console.log(`[notification.dispatch] ${tenantId}:`, s)
    }, tenantsWithQueued))
    await work('usage.collect', async () => {
      const { collectUsageDue } = await import('../services/usage')
      const n = await collectUsageDue()
      if (n) console.log(`[usage.collect] собрано: ${n}`)
    })
    // docs/v2/35 §11: ежечасно поднимает и гасит limit_notices по всем одиннадцати осям —
    // в том числе гасит те, где место освободилось и операциями оси никто не трогает
    await work('billing.limit_scan', async () => {
      const { limitScanAll } = await import('../services/limitNotices')
      const n = await limitScanAll()
      if (n) console.log(`[billing.limit_scan] поднято предупреждений: ${n}`)
    })
    // docs/v2/28 §11: воронка кандидатов — только у тенантов с включённым рекрутингом
    // (`tenants.candidates_enabled`). Круг строится по ним, а не по всем активным: у
    // остальных кандидатов нет вовсе, и проход по ним — пустая работа каждую ночь.
    await work('candidate.auto_archive', () => runPerTenant('candidate.auto_archive', async (tenantId) => {
      const n = await candidateAutoArchiveTenant(tenantId)
      if (n) console.log(`[candidate.auto_archive] ${tenantId}: заархивировано ${n}`)
    }, recruitingTenantIds))
    await work('candidate.consent_sweep', () => runPerTenant('candidate.consent_sweep', async (tenantId) => {
      const s = await candidateConsentSweepTenant(tenantId)
      if (s.erased || s.warned || s.stale) console.log(`[candidate.consent_sweep] ${tenantId}:`, s)
    }, recruitingTenantIds))
    // Планировщик: due.scan → N задач due.scan.tenant (docs/25 §5), одна на тенанта в день
    await work('due.scan', async () => {
      const day = new Date().toISOString().slice(0, 10)
      for (const tenantId of await activeTenantIds()) {
        await enqueueForTenant('due.scan.tenant', tenantId, { day }, { singletonKey: `due.scan:${tenantId}:${day}` })
      }
    })
    await perTenant<{ tenantId: string, day: string }>('due.scan.tenant', data => dueScanTenant(data.tenantId))
    // Сводные отчёты по расписанию (docs/03 §3.26) — проверка раз в час вместе с assignment.sync
    await work('assignment.sync', async () => {
      const { scheduledReportsScan } = await import('../services/reportBuilder')
      const { recalcGroups } = await import('../services/groups')
      const { escalationScan } = await import('../services/notifications')
      const { telegramHealth } = await import('../services/telegram')
      const { trajectoryScan } = await import('../services/trajectories')
      await telegramHealth() // docs/23 §10 telegram.health
      await runPerTenant('assignment.sync', async (tenantId) => {
        const n = await scheduledReportsScan(tenantId)
        if (n) console.log(`[report.scheduled] ${tenantId}: ${n}`)
        const g = await recalcGroups(tenantId) // docs/16 §11 groups.recalc — до раскрытия аудиторий
        const esc = await escalationScan(tenantId) // docs/23 §6.6 notification.escalate
        if (esc) console.log(`[notification.escalate] ${tenantId}: ${esc}`)
        if (g) console.log(`[groups.recalc] ${tenantId}: ${g}`)
        const s = await syncAssignments(tenantId)
        if (s) console.log(`[assignment.sync] ${tenantId}: +${s}`)
        // docs/33 D-026: подстраховка таймеров pg-boss траєкторій раз на добу давала запізнення до доби —
        // переведено на щогодинний скан разом з іншими assignment.sync-завданнями
        const tr = await trajectoryScan(tenantId)
        if (tr.opened || tr.fired) console.log(`[trajectory.scan] ${tenantId}:`, tr)
      })
    })
    // Занятия (docs/18 §11): статусы planned→ongoing→finished, неявки, напоминания за сутки/час.
    // docs/33 D-029: картки без сесій (kind=event, немігровані) веде meetups.ts; картки з сесіями — meetupSessions.ts
    await work('meetup.scan', async () => {
      const { reminderScan, statusScan } = await import('../services/meetups')
      const { reminderScan: sessionReminderScan, statusScan: sessionStatusScan } = await import('../services/meetupSessions')
      const { publishScan } = await import('../services/news')
      await runPerTenant('meetup.scan', async (tenantId) => {
        const p = await publishScan(tenantId) // docs/21 §11
        if (p.published || p.unpublished) console.log(`[news.publish_scan] ${tenantId}:`, p)
        const s = await statusScan(tenantId)
        const r = await reminderScan(tenantId)
        if (s.started || s.finished || r) console.log(`[meetup.scan] ${tenantId}:`, { ...s, reminded: r })
        const ss = await sessionStatusScan(tenantId)
        const sr = await sessionReminderScan(tenantId)
        if (ss.started || ss.finished || sr) console.log(`[meetup_session.scan] ${tenantId}:`, { ...ss, reminded: sr })
      })
    })
    await work('workshop.sla_scan', () => runPerTenant('workshop.sla_scan', async (tenantId) => {
      const s = await workshopSlaScan(tenantId)
      if (s.released || s.breached || s.expired) console.log(`[workshop.sla_scan] ${tenantId}:`, s)
    }))
    await work('webhook.deliver', () => runPerTenant('webhook.deliver', async (tenantId) => {
      const s = await deliverPending(tenantId)
      if (s.delivered || s.failed) console.log(`[webhook.deliver] ${tenantId}:`, s)
    }, tenantsWithPendingWebhooks))
  }
  catch (err) {
    console.error('Воркер не стартовал (очередь недоступна):', err)
  }
})
