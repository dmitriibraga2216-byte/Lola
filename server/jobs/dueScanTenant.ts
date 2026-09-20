import { runDueScan } from '../services/dueScan'

/**
 * Один тенант ежедневного `due.scan` (docs/06 §6.3, docs/25 §5): планировщик раскладывает `due.scan`
 * на N задач `due.scan.tenant`, каждая — этот обработчик; сервисы внутри работают в `withTenant`,
 * поэтому падение одного тенанта не трогает остальных (docs/25 §14 п. 7).
 */
export async function dueScanTenant(tenantId: string, monday = new Date().getDay() === 1): Promise<Record<string, unknown>> {
  const { goalDueScan } = await import('../services/development')
  const { assessmentScan } = await import('../services/assessment')
  const { actionDueScan, frequencyScan } = await import('../services/checklists')
  const { noticeScan } = await import('../services/notices')
  const { birthdayScan } = await import('../services/hubPeople')
  const { programScan } = await import('../services/programs')
  const { inactiveScan } = await import('../services/people')
  const { planPeriodScan, requestReportScan, competencyExpiryScan } = await import('../services/developmentExtra')
  const { reviewScan } = await import('../services/knowledge')
  const { weeklyDigest } = await import('../services/reportsExtra')
  const { retentionScan } = await import('../services/logs')
  const { expireExports } = await import('../services/reportExports')
  const { expireRoles } = await import('../services/positionRoleMap')
  const { trajectoryScan } = await import('../services/trajectories')

  const s = await runDueScan(tenantId)
  const inactive = await inactiveScan(tenantId) // docs/16 §11 people.inactive_scan
  const plans = await planPeriodScan(tenantId) // docs/19 §7.6 plan.period_scan
  const reqReports = await requestReportScan(tenantId) // docs/19 §7.8 request.report_reminder
  const compExpiry = await competencyExpiryScan(tenantId) // docs/19 Г-19.2 valid_until
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
  const tr = await trajectoryScan(tenantId) // docs/17: отложенные правилом прохождения, подстраховка таймеров
  const stats = { ...s, goals: g, assessment: a, actionsOverdue: ai, checklistDue: cf, notices: an, birthdays: bd, programs: pr, trajectories: tr, inactive, plans, reqReports, compExpiry, kbReview, digest, retention, expiredExports: expired, rolesExpired }
  console.log(`[due.scan] ${tenantId}:`, stats)
  return stats
}
