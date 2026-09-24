import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { attemptAnswers, attempts, locations, quizzes, reviewDelegations, reviewQueueItems, users, workshopSubmissions, workshops } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { MAX_DELEGATION_DEPTH, claimIsLive } from './reviewRules'
import { reviewConflict } from './reviewQueue'
import type { ReviewConflict } from './reviewQueue'
import type { ReviewActor } from './reviewActor'
import type { SnapshotQuestion } from '../../shared/domain/grading'

/**
 * Карточка проверки — `GET /review/items/:id` (`docs/v2/37` §5.2, §10; сквозная проверка 20
 * `docs/v2/42` §5).
 *
 * **Персональных данных человека здесь нет — ни у кого и ни в каком виде.** Проверяющий
 * оценивает работу, а не человека: в ответе имя, вид (`employee` / `candidate`), точка и сама
 * работа — ответ, критерии, история попыток. Полей `phone`, `email`, `resumeAssetId` в ответе
 * нет вовсе, а не «замаскировано»: поле, которого нет, не утечёт ни через делегирование, ни
 * через цепочку A→B→C, ни через будущую правку сериализатора (`28` §2, `37` §1, §12).
 * Для кандидата экран вместо контактов показывает плашку «Контактні дані кандидата доступні
 * рекрутеру» — по флагу `contactsHidden`.
 *
 * **Кто видит карточку** — тот, кто видит работу в каком-либо табе: назначенный (в том числе
 * делегат), тот, на кого работа эскалирована, тот, у кого карточка открыта, участник цепочки
 * делегирования, любой проверяющий для работы из общего пула и для завершённой, руководитель
 * со скоупом `review.delegate.any` в области точки. Остальным и автору самой работы — `404`:
 * существование чужой работы не подтверждается (`37` §7.7, CLAUDE.md п. 15).
 */

export interface ReviewItemCard {
  item: {
    id: string
    taskType: string
    sourceId: string
    taskTitle: string | null
    status: string
    attemptNo: number
    submittedAt: Date
    completedAt: Date | null
    slaHours: number
    slaDueAt: Date | null
    slaWarnedAt: Date | null
    slaBreachedAt: Date | null
    escalatedAt: Date | null
    escalatedToName: string | null
    assignedReviewerId: string | null
    reviewerName: string | null
    claimedBy: string | null
    delegationDepth: number
    locationName: string | null
    estimatedSeconds: number | null
    contentSeconds: number
    attemptSeconds: number
    timeConfidence: string
  }
  /** Чья работа — без контактов (сквозная проверка 20). */
  subject: { id: string, fullName: string | null, kind: string }
  /** Кандидат: вместо контактов — плашка «доступні рекрутеру» (`37` §5.2). */
  contactsHidden: boolean
  /** Цепочка передач — от первой к последней, в любом состоянии. */
  delegations: { id: string, depth: number, fromName: string | null, toName: string | null, reasonCode: string, reasonText: string | null, dueAt: Date, state: string, createdAt: Date, fromMe: boolean }[]
  conflict: ReviewConflict
  /** Что доступно смотрящему — экран не угадывает права, а читает их отсюда (CLAUDE.md п. 3). */
  can: { delegate: boolean, revoke: string | null, reassign: boolean }
  /** Содержание работы из источника по `(task_type, source_id)` — очередь его не копирует (В-2). */
  work: WorkshopWork | AnswerWork | null
}

interface WorkshopWork {
  kind: 'workshop'
  text: string
  files: { mediaId: string, name: string, kind: string }[]
  criteria: { id: string, text: string, isCritical: boolean, weight: number }[]
  reworkCount: number
  history: { attemptNo: number, status: string, reviewComment: string | null, reviewedAt: Date | null }[]
}

interface AnswerWork {
  kind: 'quiz_open_answer'
  quizTitle: string | null
  question: { kind: string, stem: unknown, points: number, criteria: string[], reference: string | null, graderHint: string | null } | null
  answer: unknown
  history: { attemptNo: number, status: string, score: number | null, submittedAt: Date | null }[]
}

export async function getReviewItem(actor: ReviewActor, itemId: string): Promise<ReviewItemCard | null> {
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const reviewer = alias(users, 'reviewer')
    const escalated = alias(users, 'escalated')
    const [row] = await tx.select({
      q: reviewQueueItems,
      // Только имя: ни телефона, ни почты, ни резюме в выборке нет — нечему и утечь.
      fullName: users.fullName,
      reviewerName: reviewer.fullName,
      escalatedToName: escalated.fullName,
      locationName: locations.name,
    })
      .from(reviewQueueItems)
      .innerJoin(users, eq(users.id, reviewQueueItems.userId))
      .leftJoin(reviewer, eq(reviewer.id, sql`coalesce(${reviewQueueItems.assignedReviewerId}, ${reviewQueueItems.claimedBy})`))
      .leftJoin(escalated, eq(escalated.id, reviewQueueItems.escalatedToId))
      .leftJoin(locations, eq(locations.id, reviewQueueItems.locationId))
      .where(eq(reviewQueueItems.id, itemId))
    if (!row) return null
    const q = row.q
    // Своя работа не показывается проверяющему никогда (§7.7).
    if (q.userId === actor.actorId) return null

    const from = alias(users, 'from_user')
    const to = alias(users, 'to_user')
    const chain = await tx.select({
      id: reviewDelegations.id,
      depth: reviewDelegations.depth,
      fromUserId: reviewDelegations.fromUserId,
      toUserId: reviewDelegations.toUserId,
      fromName: from.fullName,
      toName: to.fullName,
      reasonCode: reviewDelegations.reasonCode,
      reasonText: reviewDelegations.reasonText,
      dueAt: reviewDelegations.dueAt,
      state: reviewDelegations.state,
      createdAt: reviewDelegations.createdAt,
    }).from(reviewDelegations)
      .leftJoin(from, eq(from.id, reviewDelegations.fromUserId))
      .leftJoin(to, eq(to.id, reviewDelegations.toUserId))
      .where(eq(reviewDelegations.queueItemId, q.id))
      .orderBy(asc(reviewDelegations.createdAt))

    const me = actor.actorId
    const manager = actor.can('review.delegate.any', q.locationId)
    const visible = q.status === 'done'
      || q.assignedReviewerId === null
      || q.assignedReviewerId === me
      || q.claimedBy === me
      || (q.escalatedAt !== null && q.escalatedToId === me)
      || chain.some(d => d.fromUserId === me || d.toUserId === me)
      || manager
    if (!visible) return null

    let work: WorkshopWork | AnswerWork | null = null
    let authorIds: string[] = []
    if (q.taskType === 'workshop') {
      const [s] = await tx.select().from(workshopSubmissions).where(eq(workshopSubmissions.id, q.sourceId))
      if (s) {
        const [w] = await tx.select({ authorIds: workshops.authorIds }).from(workshops).where(eq(workshops.id, s.workshopId))
        authorIds = w?.authorIds ?? []
        const history = await tx.select({ attemptNo: workshopSubmissions.attemptNo, status: workshopSubmissions.status, reviewComment: workshopSubmissions.reviewComment, reviewedAt: workshopSubmissions.reviewedAt })
          .from(workshopSubmissions)
          .where(and(eq(workshopSubmissions.workshopId, s.workshopId), eq(workshopSubmissions.userId, s.userId), sql`${workshopSubmissions.id} <> ${s.id}::uuid`))
          .orderBy(desc(workshopSubmissions.attemptNo))
        work = {
          kind: 'workshop',
          text: (s.body as { text?: string } | null)?.text ?? '',
          files: ((s.files as { mediaId: string, name: string, kind: string }[] | null) ?? []).map(f => ({ mediaId: f.mediaId, name: f.name, kind: f.kind })),
          criteria: (s.criteriaSnapshot as WorkshopWork['criteria'] | null) ?? [],
          reworkCount: s.reworkCount,
          history,
        }
      }
    }
    else if (q.taskType === 'quiz_open_answer') {
      const [a] = await tx.select({ answer: attemptAnswers.answer, questionId: attemptAnswers.questionId, attemptId: attempts.id, quizId: attempts.quizId, userId: attempts.userId, snapshot: attempts.snapshot, quizTitle: quizzes.title, authorIds: quizzes.authorIds })
        .from(attemptAnswers)
        .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
        .innerJoin(quizzes, eq(quizzes.id, attempts.quizId))
        .where(eq(attemptAnswers.id, q.sourceId))
      if (a) {
        authorIds = a.authorIds
        const s = (a.snapshot as SnapshotQuestion[]).find(x => x.id === a.questionId)
        const history = await tx.select({ attemptNo: attempts.attemptNo, status: attempts.status, score: attempts.score, submittedAt: attempts.submittedAt })
          .from(attempts)
          .where(and(eq(attempts.quizId, a.quizId), eq(attempts.userId, a.userId)))
          .orderBy(desc(attempts.attemptNo))
        work = {
          kind: 'quiz_open_answer',
          quizTitle: a.quizTitle,
          question: s
            ? {
                kind: s.kind,
                stem: s.stem,
                points: s.points,
                criteria: (s.answer as { criteria?: string[] } | null)?.criteria ?? [],
                reference: (s.answer as { reference?: string } | null)?.reference ?? null,
                graderHint: s.graderHint ?? null,
              }
            : null,
          answer: a.answer,
          history: history.map(h => ({ ...h, score: h.score != null ? Number(h.score) : null })),
        }
      }
    }

    const open = q.status !== 'done'
    const heldByOther = !!q.claimedBy && q.claimedBy !== me && claimIsLive(q.claimedAt)
    const responsible = q.assignedReviewerId === me || q.assignedReviewerId === null || manager
    const active = chain.filter(d => d.state === 'active')
    const deepest = active[active.length - 1]
    const revokable = active.slice().reverse().find(d => d.fromUserId === me) ?? (manager ? deepest : undefined)

    return {
      item: {
        id: q.id,
        taskType: q.taskType,
        sourceId: q.sourceId,
        taskTitle: q.taskTitle,
        status: q.status,
        attemptNo: q.attemptNo,
        submittedAt: q.submittedAt,
        completedAt: q.completedAt,
        slaHours: q.slaHours,
        slaDueAt: q.slaDueAt,
        slaWarnedAt: q.slaWarnedAt,
        slaBreachedAt: q.slaBreachedAt,
        escalatedAt: q.escalatedAt,
        escalatedToName: row.escalatedToName,
        assignedReviewerId: q.assignedReviewerId,
        reviewerName: row.reviewerName,
        claimedBy: q.claimedBy,
        delegationDepth: q.delegationDepth,
        locationName: row.locationName,
        estimatedSeconds: q.estimatedSeconds,
        contentSeconds: q.contentSeconds,
        attemptSeconds: q.attemptSeconds,
        timeConfidence: q.timeConfidence,
      },
      subject: { id: q.userId, fullName: row.fullName, kind: q.subjectKind },
      contactsHidden: q.subjectKind === 'candidate',
      delegations: chain.map(d => ({
        id: d.id,
        depth: d.depth,
        fromName: d.fromName,
        toName: d.toName,
        reasonCode: d.reasonCode,
        reasonText: d.reasonText,
        dueAt: d.dueAt,
        state: d.state,
        createdAt: d.createdAt,
        fromMe: d.fromUserId === me,
      })),
      conflict: await reviewConflict(tx, { actorId: me, subjectUserId: q.userId, authorIds }),
      can: {
        // «Делегувати» неактивна при глубине 2 (§5.2) и пока карточку держит другой.
        delegate: open && responsible && !heldByOther && q.delegationDepth < MAX_DELEGATION_DEPTH,
        revoke: open && revokable ? revokable.id : null,
        reassign: open && manager,
      },
      work,
    }
  })
}
