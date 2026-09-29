import { eq, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { EnrollmentStatus } from '../../shared/enums'
import { candidates as candidatesQuery } from './repo/people'
import { scopeCond } from './candidates'
import type { Viewer } from './candidates'

/**
 * Вкладка «Проходження» карточки кандидата (docs/v2/28-recruiting-candidates.md §5.3 п. 2):
 * назначения со статусами из пяти канонических, прогресс, попытки, «Час на контент» и
 * «Час на випробування» (docs/v2/37 §7.11).
 *
 * Сервер считает, экран показывает (CLAUDE.md п. 3): статус — тот, что записан в
 * `enrollments.status` правилами прохождения, а не выведенный здесь заново; время — зачтённое
 * свёрткой `time.rollup` (`learning_time_totals`), а не «сырые» тики. Отменённые назначения
 * (`cancelled_at`) не показываются — их у кандидата нет, как нет и у сотрудника в «Навчанні».
 *
 * Кто видит — тот же, кто видит карточку (`scopeCond`): наставнику §2 открывает «историю
 * попыток» в объёме его проверки, и вкладка ему тоже открыта. Чужой кандидат — `null` → `404`.
 */

export interface ProgressAttempt {
  id: string
  enrollmentId: string | null
  title: string | null
  attemptNo: number
  status: string
  score: number | null
  maxScore: number | null
  passed: boolean | null
  startedAt: Date
  submittedAt: Date | null
}

export interface ProgressItem {
  enrollmentId: string
  subjectType: string
  subjectId: string
  title: string | null
  status: EnrollmentStatus
  progressPct: number
  dueAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  score: number | null
  /** Просрочено: срок прошёл, а прохождение не завершено (docs/02 «протерміновано»). */
  overdue: boolean
  attemptsCount: number
  /** «Час на контент» и «Час на випробування», секунды (docs/v2/37 §7.11). */
  contentSeconds: number
  attemptSeconds: number
}

export interface CandidateProgress {
  items: ProgressItem[]
  attempts: ProgressAttempt[]
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export async function candidateProgress(v: Viewer, id: string): Promise<CandidateProgress | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [target] = await candidatesQuery(tx, { id: users.id }, eq(users.id, id), scopeCond(v))
    if (!target) return null

    const enrollments = await tx.execute(sql`
      select e.id, e.subject_type, e.subject_id, e.status, e.progress_pct, e.due_at, e.started_at, e.completed_at, e.score,
             coalesce(c.title, p.title, q.title) as title,
             (select count(*)::int from attempts a where a.enrollment_id = e.id and a.status <> 'annulled') as attempts_count,
             (select coalesce(sum(t.content_seconds), 0)::int from learning_time_totals t where t.enrollment_id = e.id) as content_seconds,
             (select coalesce(sum(t.attempt_seconds), 0)::int from learning_time_totals t where t.enrollment_id = e.id) as attempt_seconds,
             (e.due_at is not null and e.due_at < now() and e.status in ('not_started', 'in_progress')) as overdue
        from enrollments e
        left join courses c on e.subject_type = 'course' and c.id = e.subject_id
        left join programs p on e.subject_type = 'training_program' and p.id = e.subject_id
        left join quizzes q on e.subject_type = 'test' and q.id = e.subject_id
       where e.user_id = ${id}::uuid and e.cancelled_at is null
       order by e.created_at desc, e.id desc
       limit 200`) as unknown as Record<string, unknown>[]

    const attempts = await tx.execute(sql`
      select a.id, a.enrollment_id, a.attempt_no, a.status, a.score, a.max_score, a.passed, a.started_at, a.submitted_at, q.title
        from attempts a join quizzes q on q.id = a.quiz_id
       where a.user_id = ${id}::uuid and a.status <> 'annulled'
       order by a.started_at desc, a.id desc
       limit 200`) as unknown as Record<string, unknown>[]

    return {
      items: enrollments.map(r => ({
        enrollmentId: String(r.id),
        subjectType: String(r.subject_type),
        subjectId: String(r.subject_id),
        title: (r.title as string | null) ?? null,
        status: r.status as EnrollmentStatus,
        progressPct: Number(r.progress_pct ?? 0),
        dueAt: (r.due_at as Date | null) ?? null,
        startedAt: (r.started_at as Date | null) ?? null,
        completedAt: (r.completed_at as Date | null) ?? null,
        score: num(r.score),
        overdue: r.overdue === true,
        attemptsCount: Number(r.attempts_count ?? 0),
        contentSeconds: Number(r.content_seconds ?? 0),
        attemptSeconds: Number(r.attempt_seconds ?? 0),
      })),
      attempts: attempts.map(r => ({
        id: String(r.id),
        enrollmentId: (r.enrollment_id as string | null) ?? null,
        title: (r.title as string | null) ?? null,
        attemptNo: Number(r.attempt_no),
        status: String(r.status),
        score: num(r.score),
        maxScore: num(r.max_score),
        passed: (r.passed as boolean | null) ?? null,
        startedAt: r.started_at as Date,
        submittedAt: (r.submitted_at as Date | null) ?? null,
      })),
    }
  })
}
