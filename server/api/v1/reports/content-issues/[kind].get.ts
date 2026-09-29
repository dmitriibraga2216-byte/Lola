import { can, requireScope, scopeForGrants } from '../../../../services/access'
import {
  authorDisciplineReport, complaintsReport, problemQuestionsReport, reportersReport,
} from '../../../../services/contentIssueReports'
import { toCsv } from '../../../../services/reportExports'
import { toXlsx } from '../../../../services/reports'
import { apiData, apiError } from '../../../../utils/apiResponse'
import { CONTENT_ISSUE_REPORT_KINDS, contentIssueReportQuerySchema } from '../../../../../shared/schemas/contentIssues'
import type { ContentIssueReportKind } from '../../../../../shared/schemas/contentIssues'

/**
 * GET /reports/content-issues/:kind — четыре отчёта модуля жалоб (docs/v2/36 §9) рядом
 * с «Якість контенту»: `complaints` «Скарги», `authors` «Дисципліна авторів», `questions`
 * «Проблемні питання», `reporters` «Заявники».
 *
 * Первые три — скоуп `content_issue.view` (керівник точки — по своим точкам, методист,
 * администратор, §2); «Заявники» — «только для admin» (§9): скоуп `content_issue.mute`, тот
 * же, что снимает и ставит mute. Область видимости параметром не расширяется (docs/22 §7.1).
 * Выгрузка — `report.export`, теми же строками, что и экран; «Скарги» — CSV и XLSX.
 */
export default defineEventHandler(async (event) => {
  const kind = getRouterParam(event, 'kind') as ContentIssueReportKind
  if (!(CONTENT_ISSUE_REPORT_KINDS as readonly string[]).includes(kind)) return apiError(event, 404, 'not_found', 'Звіт не знайдено')
  const a = kind === 'reporters' ? await requireScope(event, 'content_issue.mute') : await requireScope(event, 'content_issue.view')
  const p = contentIssueReportQuerySchema.safeParse(getQuery(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте фільтри звіту', { issues: p.error.issues })
  const scope = kind === 'reporters'
    ? await scopeForGrants(a, 'content_issue.mute', 'content_issue.mute')
    : await scopeForGrants(a, 'content_issue.assign', 'content_issue.view')
  const v = { tenantId: a.tenantId, actorId: a.userId, scope }

  let flat: Record<string, unknown>[]
  let report: { rows: unknown[] }
  if (kind === 'complaints') {
    const r = await complaintsReport(v, p.data)
    report = r
    flat = r.rows.map(x => ({
      reported_at: x.reportedAt, issue_type: x.issueType, target_type: x.targetType, element: x.title,
      tracks: x.tracks.map(t => t.title).join(', '), version: x.contentVersion, reporters: x.reporters,
      status: x.status, resolution: x.resolution ?? '', assignee: x.assignee ?? '', due_at: x.dueAt ?? '',
      overdue_days: x.overdueDays ?? '', rescore_state: x.rescoreState,
    }))
  }
  else if (kind === 'authors') {
    const r = await authorDisciplineReport(v, p.data)
    report = r
    flat = r.rows.map(x => ({
      assignee: x.name ?? '', active: x.active ?? '', open: x.open, overdue: x.overdue, decided: x.decided,
      avg_days_to_fix: x.avgDaysToFix ?? '', rejected_pct: x.rejectedPct ?? '',
    }))
  }
  else if (kind === 'questions') {
    const r = await problemQuestionsReport(v, p.data)
    report = r
    flat = r.rows.map(x => ({
      question: x.title, quizzes: x.quizzes.map(z => z.title).join(', '), complaints: x.complaints, cards: x.cards,
      answers: x.answers, wrong_pct: x.wrongPct ?? '', rescore_state: x.rescoreState, suspect: x.suspect,
    }))
  }
  else {
    const r = await reportersReport(v, p.data)
    report = r
    flat = r.rows.map(x => ({
      full_name: x.fullName, location: x.location ?? '', reports: x.reports, confirmed: x.confirmed,
      rejected: x.rejected, spam: x.spam, confirmed_pct: x.confirmedPct ?? '', trusted: x.trusted, muted_until: x.mutedUntil ?? '',
    }))
  }

  if (p.data.format !== 'json') {
    if (!can(a, 'report.export')) return apiError(event, 403, 'forbidden', 'Немає права на вивантаження')
    if (p.data.format === 'csv') {
      if (kind !== 'complaints') return apiError(event, 422, 'validation_failed', 'CSV доступний лише для звіту «Скарги»')
      setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
      setHeader(event, 'Content-Disposition', `attachment; filename="lola-content-${kind}.csv"`)
      return toCsv(flat as never)
    }
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="lola-content-${kind}.xlsx"`)
    return toXlsx(`content-${kind}`, flat as never)
  }
  return apiData(report)
})
