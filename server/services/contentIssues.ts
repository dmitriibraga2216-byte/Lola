import { and, count, eq, gte, isNotNull, sql } from 'drizzle-orm'
import {
  attempts, contentIssueEvents, contentIssues, contentReporterStats, contentReports,
  courseVersions, knowledgeArticles, lessons, mediaAssets, modules, questions, quizzes,
  resourceVersions, resources, surveys, workshops,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import { assignTx, authorIdsSql, derivedCourseIds, routeIssueTx, uuidArray } from './contentIssueRouting'
import { notifyAssignee } from './contentIssueNotify'
import {
  checkRate, deadlineShiftFor, dedupeKeyOf, dueAtFor, nextReporterState, rateWindows, severityOf,
} from '../../shared/domain/contentIssues'
import type { ContentIssueTargetType } from '../../shared/enums'
import type { ContentReportInput, ContentReportResult } from '../../shared/schemas/contentIssues'
import { CONTENT_ISSUE_LIMITS } from '../../shared/enums'

/**
 * Подача жалобы на материал (docs/v2/36-content-feedback.md §7.1, §7.2, §7.7, §7.10).
 *
 * Модуль живёт правилом «минимум трения для заявителя, максимум контекста для автора»
 * (§1). Отсюда всё устройство сервиса:
 *
 * - **человек не описывает контекст словами.** Версию материала, версию вопроса, урок,
 *   попытку и заголовок карточки считает сервер (CLAUDE.md п. 3); клиент присылает только
 *   то, чего сервер знать не может — позицию плеера, прокрутку, вьюпорт;
 * - **склейка — индексом, а не кодом.** Открытая карточка с тем же `dedupe_key` получает
 *   `reports_count += 1` и событие `merged`; сорок жалоб на одно битое видео дают одну
 *   карточку, а не сорок строк в очереди автора (§12);
 * - **жалоба не блокирует попытку** (§7.7). Она не трогает ни снапшот (правило 4), ни
 *   статус попытки; время, потраченное на форму, возвращается сдвигом `deadline_at` —
 *   до 60 секунд на жалобу и не больше 180 за попытку;
 * - **отказ всегда объясняет себя.** Шестая жалоба за сутки отвергается кодом
 *   `content_issue.rate_limited` с числом поданных и пределом, а не молчанием (§13 к. 7).
 */

export interface Ctx { tenantId: string, actorId: string }

export type SubmitResult
  = | { ok: true, result: ContentReportResult }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'already_reported', issueId: string }
    | { ok: false, code: 'reporter_muted', until: Date | null }
    | { ok: false, code: 'rate_limited', reason: 'per_day' | 'per_month' | 'per_attempt', used: number, limit: number }

/** Заголовок карточки и версия материала — из самого материала, не из формы (§5.2). */
interface ResolvedTarget { title: string, contentVersion: number, courseIds: string[], lessonRequired: boolean, archived: boolean }

/** Первые 200 символов текста вопроса — заголовком карточки (у вопроса своего title нет). */
function stemText(stem: unknown): string {
  const blocks = Array.isArray(stem) ? stem : []
  for (const b of blocks as { type?: string, text?: string, html?: string }[]) {
    const raw = b.html ?? b.text
    if (typeof raw === 'string' && raw.trim()) return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return ''
}

/**
 * Что это за материал: заголовок для карточки, действующая версия и курсы, где он
 * встречается (колонка «Трек» очереди, §5.3). Возвращает null, если материала нет или он
 * чужого тенанта — вызывающий отвечает 404, а не 403 (CLAUDE.md п. 15).
 */
async function resolveTarget(tx: TenantTx, ctx: Ctx, targetType: ContentIssueTargetType, targetId: string, lessonId?: string | null): Promise<ResolvedTarget | null> {
  let title = ''
  let contentVersion = 1
  let archived = false

  switch (targetType) {
    case 'resource':
    case 'block': {
      const [r] = await tx.select({ title: resources.title, status: resources.status }).from(resources).where(eq(resources.id, targetId))
      if (!r) return null
      title = r.title
      archived = r.status === 'archived'
      const [v] = await tx.select({ version: sql<number>`max(${resourceVersions.version})` }).from(resourceVersions).where(eq(resourceVersions.resourceId, targetId))
      contentVersion = v?.version ?? 1
      break
    }
    case 'lesson': {
      // Версия урока — версия курса, в которую он входит: публикация курса копирует уроки в
      // новую версию (`ensureDraftVersion`), и «опубликована версия выше» (§7.9) для урока
      // значит «опубликована версия курса выше» (PR-24; раньше здесь всегда стояла 1)
      const [l] = await tx.select({ title: lessons.title, version: courseVersions.version })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
        .where(eq(lessons.id, targetId))
      if (!l) return null
      title = l.title
      contentVersion = l.version
      break
    }
    case 'quiz': {
      const [q] = await tx.select({ title: quizzes.title, status: quizzes.status }).from(quizzes).where(eq(quizzes.id, targetId))
      if (!q) return null
      title = q.title
      archived = q.status === 'archived'
      break
    }
    case 'question': {
      const [q] = await tx.select({ stem: questions.stem, version: questions.version, status: questions.status }).from(questions).where(eq(questions.id, targetId))
      if (!q) return null
      title = stemText(q.stem)
      contentVersion = q.version
      archived = q.status === 'archived'
      break
    }
    case 'workshop': {
      const [w] = await tx.select({ title: workshops.title }).from(workshops).where(eq(workshops.id, targetId))
      if (!w) return null
      title = w.title
      break
    }
    case 'survey': {
      const [s] = await tx.select({ title: surveys.title }).from(surveys).where(eq(surveys.id, targetId))
      if (!s) return null
      title = s.title
      break
    }
    case 'knowledge_article': {
      const [a] = await tx.select({ title: knowledgeArticles.title, version: knowledgeArticles.version, status: knowledgeArticles.status })
        .from(knowledgeArticles).where(eq(knowledgeArticles.id, targetId))
      if (!a) return null
      title = a.title
      contentVersion = a.version
      archived = a.status === 'archived'
      break
    }
    case 'media': {
      const [m] = await tx.select({ name: mediaAssets.originalName }).from(mediaAssets).where(eq(mediaAssets.id, targetId))
      if (!m) return null
      title = m.name
      break
    }
  }

  // Урок даёт и обязательность (она поднимает severity, §7.4), и курс для колонки «Трек»
  let lessonRequired = false
  const courseIds: string[] = []
  if (lessonId) {
    const [l] = await tx.select({ isRequired: lessons.isRequired, courseId: courseVersions.courseId })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .innerJoin(courseVersions, eq(courseVersions.id, modules.courseVersionId))
      .where(eq(lessons.id, lessonId))
    if (l) {
      lessonRequired = l.isRequired
      if (l.courseId) courseIds.push(l.courseId)
    }
  }

  return { title: title.slice(0, 200), contentVersion, courseIds, lessonRequired, archived }
}

/**
 * Версия вопроса из снапшота попытки (правило 4: снапшот неизменен, версия берётся оттуда).
 * Снапшот попытки — массив вопросов (`attempts.ts` `buildSnapshot`); форма `{ questions: […] }`
 * поддерживается для старых записей тестов PR-23. PR-24: раньше функция читала только её, и на
 * настоящей попытке версия молча бралась из текущей редакции вопроса.
 */
function versionFromSnapshot(snapshot: unknown, questionId: string): number | null {
  const list = Array.isArray(snapshot) ? snapshot : (snapshot as { questions?: unknown } | null)?.questions
  const q = Array.isArray(list) ? (list as { id: string, version?: number }[]).find(x => x?.id === questionId) : undefined
  return q?.version ?? null
}

/** Сколько секунд уже компенсировано этой попытке (§7.7 б) — из журнала карточек. */
async function shiftedForAttempt(tx: TenantTx, ctx: Ctx, attemptId: string): Promise<number> {
  const [row] = await tx.execute(sql`
    select coalesce(sum((payload->>'deadline_shift_sec')::int), 0)::int as total
    from content_issue_events
    where tenant_id = ${ctx.tenantId}::uuid and payload->>'attempt_id' = ${attemptId}
  `) as unknown as { total: number }[]
  return row?.total ?? 0
}

/**
 * Подача жалобы (§10 `POST /content-issues/reports`).
 *
 * `exemptFromLimits` — носитель `content_issue.triage`: лимиты частоты к нему не
 * применяются (§7.10), иначе методист упрётся в них на четвёртой карточке очереди.
 */
export async function submitReport(ctx: Ctx, input: ContentReportInput, opts: { exemptFromLimits?: boolean } = {}): Promise<SubmitResult> {
  const now = new Date()
  return withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<SubmitResult> => {
    // ── 1. Материал существует и он нашего тенанта (RLS уже сузила выборку) ──────────────
    const target = await resolveTarget(tx, ctx, input.targetType, input.targetId, input.lessonId)
    if (!target) return { ok: false as const, code: 'not_found' as const }
    // Колонка «Трек» (§5.3) — все курсы, где встречается элемент, а не только тот, откуда пришёл
    // заявитель: методист видит масштаб дефекта раньше, чем откроет карточку (PR-24)
    target.courseIds = [...new Set([...target.courseIds, ...await derivedCourseIds(tx, input.targetType, input.targetId)])]

    // ── 2. Попытка: версия вопроса из снапшота, а не из текущей редакции ────────────────
    let attempt: { id: string, deadlineAt: Date | null, snapshot: unknown } | null = null
    if (input.attemptId) {
      const [a] = await tx.select({ id: attempts.id, deadlineAt: attempts.deadlineAt, snapshot: attempts.snapshot, userId: attempts.userId })
        .from(attempts).where(eq(attempts.id, input.attemptId))
      if (!a || a.userId !== ctx.actorId) return { ok: false as const, code: 'not_found' as const }
      attempt = { id: a.id, deadlineAt: a.deadlineAt, snapshot: a.snapshot }
    }
    const questionVersion = attempt && input.targetType === 'question' ? versionFromSnapshot(attempt.snapshot, input.targetId) : null
    const contentVersion = questionVersion ?? target.contentVersion

    // ── 3. Скриншот — файл хранилища с `origin='issue_screenshot'` (§6.1, `40` §4) ───────
    if (input.screenshotMediaId) {
      const [m] = await tx.select({ id: mediaAssets.id, origin: mediaAssets.origin })
        .from(mediaAssets).where(eq(mediaAssets.id, input.screenshotMediaId))
      if (!m || m.origin !== 'issue_screenshot') return { ok: false as const, code: 'not_found' as const }
    }

    // ── 4. Репутация: mute старше лимитов — молчащий человек не считает жалобы (§7.11) ──
    const [stats] = await tx.select().from(contentReporterStats)
      .where(and(eq(contentReporterStats.tenantId, ctx.tenantId), eq(contentReporterStats.userId, ctx.actorId)))
    if (stats?.mutedUntil && stats.mutedUntil > now) {
      return { ok: false as const, code: 'reporter_muted' as const, until: stats.mutedUntil }
    }

    // ── 5. Частота (§7.10). Отказ называет предел — это и есть «текстом, а не молча» ────
    const { dayFrom, monthFrom } = rateWindows(now)
    const [dayRow] = await tx.select({ n: count() }).from(contentReports)
      .where(and(eq(contentReports.tenantId, ctx.tenantId), eq(contentReports.userId, ctx.actorId), gte(contentReports.createdAt, dayFrom)))
    const [monthRow] = await tx.select({ n: count() }).from(contentReports)
      .where(and(eq(contentReports.tenantId, ctx.tenantId), eq(contentReports.userId, ctx.actorId), gte(contentReports.createdAt, monthFrom)))
    let attemptCount = 0
    if (attempt) {
      const [r] = await tx.select({ n: count() }).from(contentReports)
        .where(and(eq(contentReports.tenantId, ctx.tenantId), eq(contentReports.userId, ctx.actorId), eq(contentReports.attemptId, attempt.id)))
      attemptCount = r?.n ?? 0
    }
    const verdict = checkRate(
      { day: dayRow?.n ?? 0, month: monthRow?.n ?? 0, attempt: attemptCount },
      { exempt: opts.exemptFromLimits, inAttempt: !!attempt },
    )
    if (!verdict.ok) return { ok: false as const, code: 'rate_limited' as const, reason: verdict.reason, used: verdict.used, limit: verdict.limit }

    // ── 6. Склейка (§7.2): открытая карточка с тем же ключом принимает голос ────────────
    const dedupeKey = dedupeKeyOf({
      targetType: input.targetType, targetId: input.targetId,
      blockId: input.blockId, issueType: input.issueType, contentVersion,
    })
    const severity = severityOf(input.issueType, { lessonRequired: target.lessonRequired, archived: target.archived })
    // Жалоба на вопрос во время попытки всегда влияет на баллы (§7.7 в): карточка попадает
    // в очередь с пометкой «впливає на бали» и не может быть тихо закрыта
    const affectsScoring = !!attempt && input.targetType === 'question'

    const [inserted] = await tx.insert(contentIssues).values({
      tenantId: ctx.tenantId,
      targetType: input.targetType,
      targetId: input.targetId,
      blockId: input.blockId ?? null,
      contentVersion,
      issueType: input.issueType,
      title: target.title.length >= 3 ? target.title : input.issueType,
      dedupeKey,
      severity,
      affectsScoring,
      rescoreState: affectsScoring ? 'needed' : 'none',
      courseIds: target.courseIds,
      dueAt: dueAtFor(severity, now, { archived: target.archived }),
      firstReportedAt: now,
      lastReportedAt: now,
    }).onConflictDoNothing().returning({ id: contentIssues.id })

    let issueId = inserted?.id
    const merged = !inserted
    if (!issueId) {
      const [open] = await tx.select({ id: contentIssues.id }).from(contentIssues)
        .where(and(eq(contentIssues.tenantId, ctx.tenantId), eq(contentIssues.dedupeKey, dedupeKey), sql`${contentIssues.status} <> 'closed'`))
      if (!open) return { ok: false as const, code: 'not_found' as const }
      issueId = open.id
    }

    // ── 7. Обращение. Повторная жалоба того же человека — 409, счётчик не растёт (§7.2) ─
    const context = {
      ...input.context,
      course_ids: target.courseIds,
      lesson_id: input.lessonId ?? null,
      enrollment_id: input.enrollmentId ?? null,
      attempt_id: attempt?.id ?? null,
      item_type: input.targetType,
      item_id: input.targetId,
      block_id: input.blockId ?? null,
      content_version: contentVersion,
      question_version: questionVersion,
      server_ts: now.toISOString(),
      request_context: currentRequestContext(),
    }
    const [report] = await tx.insert(contentReports).values({
      tenantId: ctx.tenantId,
      issueId,
      userId: ctx.actorId,
      comment: input.comment ?? null,
      context,
      screenshotMediaId: input.screenshotMediaId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      lessonId: input.lessonId ?? null,
      attemptId: attempt?.id ?? null,
      questionVersion,
      source: input.source,
    }).onConflictDoNothing().returning({ id: contentReports.id })
    if (!report) return { ok: false as const, code: 'already_reported' as const, issueId }

    if (merged) {
      await tx.update(contentIssues)
        .set({
          reportsCount: sql`${contentIssues.reportsCount} + 1`,
          lastReportedAt: now,
          courseIds: sql`array(select distinct c from unnest(${contentIssues.courseIds} || ${uuidArray(target.courseIds)}) c)`,
          updatedAt: now,
        })
        .where(and(eq(contentIssues.tenantId, ctx.tenantId), eq(contentIssues.id, issueId)))
      // Жалоба во время попытки поднимает флаг и у уже открытой карточки (§7.7 в)
      if (affectsScoring) {
        await tx.update(contentIssues)
          .set({ affectsScoring: true, rescoreState: sql`case when ${contentIssues.rescoreState} = 'none' then 'needed' else ${contentIssues.rescoreState} end`, updatedAt: now })
          .where(and(eq(contentIssues.tenantId, ctx.tenantId), eq(contentIssues.id, issueId)))
      }
    }

    // ── 8. Компенсация времени попытки (§7.7 б): попытка не прерывается ─────────────────
    // Сдвигается только `deadline_at`. Снапшот, статус и ответы не трогаются вовсе —
    // жалоба не участвует в прохождении, она про материал (правило 4).
    let deadlineShiftSec = 0
    if (attempt?.deadlineAt) {
      const already = await shiftedForAttempt(tx, ctx, attempt.id)
      deadlineShiftSec = deadlineShiftFor(input.context.formSeconds, already)
      if (deadlineShiftSec > 0) {
        await tx.update(attempts)
          .set({ deadlineAt: new Date(attempt.deadlineAt.getTime() + deadlineShiftSec * 1000), updatedAt: now })
          .where(and(eq(attempts.tenantId, ctx.tenantId), eq(attempts.id, attempt.id)))
      }
    }

    // ── 9. Журнал карточки (§3): `created` или `merged` — критерий приёмки 2 ────────────
    await tx.insert(contentIssueEvents).values({
      tenantId: ctx.tenantId,
      issueId,
      actorId: ctx.actorId,
      kind: merged ? 'merged' : 'created',
      toStatus: merged ? null : 'new',
      payload: {
        report_id: report.id,
        attempt_id: attempt?.id ?? null,
        deadline_shift_sec: deadlineShiftSec,
        dedupe_key: dedupeKey,
      },
      requestContext: currentRequestContext(),
    })

    // ── 10. Репутация заявителя (§7.11): счётчик подач и время последней ────────────────
    await tx.insert(contentReporterStats).values({
      tenantId: ctx.tenantId, userId: ctx.actorId, reportsTotal: 1, lastReportAt: now,
    }).onConflictDoUpdate({
      target: [contentReporterStats.tenantId, contentReporterStats.userId],
      set: { reportsTotal: sql`${contentReporterStats.reportsTotal} + 1`, lastReportAt: now, updatedAt: now },
    })

    // ── 11. Адресат и уведомления (PR-24, §7.5, §8) ──────────────────────────────────────
    if (merged) await notifyAssignee(tx, ctx.tenantId, issueId, 'content_issue_merged')
    else await routeNewIssue(tx, ctx, issueId)

    return {
      ok: true as const,
      result: {
        issueId,
        reportId: report.id,
        merged,
        deadlineShiftSec,
        reportsToday: (dayRow?.n ?? 0) + 1,
        limitPerDay: CONTENT_ISSUE_LIMITS.perDay,
      },
    }
  })
}

/**
 * Итог разбора для репутации заявителей (§7.11). Вызывается разбором жалобы (PR-24):
 * резолюция `spam` копит серию и на третьей подряд молча не остаётся — ставит
 * `muted_until` на 14 дней; подтверждённая жалоба серию обнуляет.
 *
 * Возвращает id людей, которым mute поставлен только что, — уведомление им и их
 * руководителю отправляет вызывающий (`content_reporter_muted`, §8).
 */
export async function applyResolutionToReporters(
  ctx: Ctx,
  issueId: string,
  resolution: 'spam' | 'confirmed' | 'rejected',
): Promise<string[]> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => applyResolutionToReportersTx(tx, ctx, issueId, resolution))
}

/**
 * То же внутри транзакции разбора (PR-24): резолюция, репутация заявителей и уведомление
 * о mute фиксируются одной транзакцией — иначе отказ мог бы сохраниться без серии `spam`.
 */
export async function applyResolutionToReportersTx(
  tx: TenantTx,
  ctx: Ctx,
  issueId: string,
  resolution: 'spam' | 'confirmed' | 'rejected',
): Promise<string[]> {
  const now = new Date()
  const reporters = await tx.select({ userId: contentReports.userId }).from(contentReports)
    .where(and(eq(contentReports.tenantId, ctx.tenantId), eq(contentReports.issueId, issueId)))
  const muted: string[] = []
  for (const r of reporters) {
    const [prev] = await tx.select().from(contentReporterStats)
      .where(and(eq(contentReporterStats.tenantId, ctx.tenantId), eq(contentReporterStats.userId, r.userId)))
    const base = {
      spamCount: prev?.spamCount ?? 0,
      consecutiveSpam: prev?.consecutiveSpam ?? 0,
      confirmedCount: prev?.confirmedCount ?? 0,
      rejectedCount: prev?.rejectedCount ?? 0,
      mutedUntil: prev?.mutedUntil ?? null,
    }
    const next = nextReporterState(base, resolution, now)
    await tx.insert(contentReporterStats).values({
      tenantId: ctx.tenantId, userId: r.userId,
      reportsTotal: prev?.reportsTotal ?? 0,
      spamCount: next.spamCount, consecutiveSpam: next.consecutiveSpam,
      confirmedCount: next.confirmedCount, rejectedCount: next.rejectedCount,
      mutedUntil: next.mutedUntil,
      muteReason: next.autoMuted ? 'auto_spam_streak' : (prev?.muteReason ?? null),
    }).onConflictDoUpdate({
      target: [contentReporterStats.tenantId, contentReporterStats.userId],
      set: {
        spamCount: next.spamCount, consecutiveSpam: next.consecutiveSpam,
        confirmedCount: next.confirmedCount, rejectedCount: next.rejectedCount,
        mutedUntil: next.mutedUntil,
        ...(next.autoMuted ? { muteReason: 'auto_spam_streak' } : {}),
        updatedAt: now,
      },
    })
    if (next.autoMuted) muted.push(r.userId)
  }
  return muted
}

/**
 * Новая карточка получает ответственного сразу при подаче (§7.5), событием `assigned` от
 * системы. Автор, пожаловавшийся на свой материал, берёт карточку в работу сам (§12): она
 * сразу `in_progress` на нём. Карточка `blocking` будит ответственного и администраторов (§8).
 */
async function routeNewIssue(tx: TenantTx, ctx: Ctx, issueId: string): Promise<void> {
  const [self] = await tx.execute(sql`
    select ${ctx.actorId}::uuid = any(${authorIdsSql('i')}) as is_author
      from content_issues i where i.id = ${issueId}::uuid`) as unknown as { is_author: boolean }[]
  if (self?.is_author) {
    await assignTx(tx, ctx.tenantId, issueId, ctx.actorId, { actorId: ctx.actorId, from: null, step: 'author' })
    await tx.update(contentIssues).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(contentIssues.id, issueId))
    await tx.insert(contentIssueEvents).values({
      tenantId: ctx.tenantId, issueId, actorId: ctx.actorId, kind: 'status_changed',
      fromStatus: 'new', toStatus: 'in_progress', payload: { self_report: true },
      requestContext: currentRequestContext(),
    })
  }
  else {
    const route = await routeIssueTx(tx, issueId)
    if (route.assigneeId) {
      await assignTx(tx, ctx.tenantId, issueId, route.assigneeId, { actorId: null, from: null, step: route.step, ruleId: route.ruleId })
      await notifyAssignee(tx, ctx.tenantId, issueId, 'content_issue_created')
    }
  }
  const [row] = await tx.select({ severity: contentIssues.severity }).from(contentIssues).where(eq(contentIssues.id, issueId))
  if (row?.severity === 'blocking') await notifyAssignee(tx, ctx.tenantId, issueId, 'content_issue_blocking')
}

/** Свои жалобы со статусами — «Мої повідомлення про помилки» (§5.5). */
export async function myReports(ctx: Ctx, limit = 50) {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => tx
    .select({
      reportId: contentReports.id,
      createdAt: contentReports.createdAt,
      issueId: contentIssues.id,
      issueType: contentIssues.issueType,
      targetType: contentIssues.targetType,
      title: contentIssues.title,
      status: contentIssues.status,
      resolution: contentIssues.resolution,
      resolutionComment: contentIssues.resolutionComment,
      hasScreenshot: isNotNull(contentReports.screenshotMediaId),
    })
    .from(contentReports)
    .innerJoin(contentIssues, eq(contentIssues.id, contentReports.issueId))
    .where(and(eq(contentReports.tenantId, ctx.tenantId), eq(contentReports.userId, ctx.actorId)))
    .orderBy(sql`${contentReports.createdAt} desc`)
    .limit(limit))
}
