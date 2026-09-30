import { and, eq, inArray, sql } from 'drizzle-orm'
import { assignments, interviewScenarios, quizzes, users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { resolveAudience } from './audience'
import { enqueueNotification } from './notifications'
import { candidateOnly } from './repo/people'
import { interviewEstimateMinutes } from '../../shared/domain/interview'
import type { Audience } from '../../shared/schemas/assignments'

/**
 * `interview.invited` (`docs/v2/30-ai-interview.md` §8, `44` Р-AI2.8): «Наступний крок відбору —
 * електронна співбесіда, близько {N} хв. Посилання діє до {дата}.» — кандидату, e-mail и Telegram,
 * когда ему назначен тест собеседования.
 *
 * Назначение теста записей не создаёт (правила берутся при старте попытки, `assignments.ts`),
 * поэтому «назначен» — это «попал в аудиторию активного назначения теста вида `interview` с
 * опубликованным сценарием». Шлёт раскрытие назначения (`expandAssignment`): при создании и при
 * часовой синхронизации — кандидат, добавленный в аудиторию позже, получит своё приглашение.
 * Повтор не шлёт: ключ `interview_invited:<назначение>:<человек>:<канал>`. Сотрудникам не шлём:
 * документ говорит о кандидате (сотрудник видит тест в своём обучении).
 *
 * Срок ссылки — ближайший из срока назначения и срока доступа кандидата (`users.access_until`):
 * после любого из них вход закрыт. Нет ни того, ни другого — строка о сроке опускается.
 */
export const INTERVIEW_INVITE_CHANNELS = ['email', 'telegram'] as const

export async function inviteToInterviewTx(tx: TenantTx, tenantId: string, assignmentId: string): Promise<number> {
  const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId))
  if (!a || a.status !== 'active' || a.subjectType !== 'test') return 0
  const [quiz] = await tx.select({ id: quizzes.id, kind: quizzes.kind, questionCount: quizzes.questionCount })
    .from(quizzes).where(and(eq(quizzes.id, a.subjectId), sql`${quizzes.deletedAt} is null`))
  if (!quiz || quiz.kind !== 'interview') return 0
  const [scenario] = await tx.select({ thinkTimeSec: interviewScenarios.thinkTimeSec, minAnswerSec: interviewScenarios.minAnswerSec, maxAnswerSec: interviewScenarios.maxAnswerSec })
    .from(interviewScenarios).where(and(eq(interviewScenarios.quizId, quiz.id), eq(interviewScenarios.status, 'published')))
  if (!scenario) return 0 // сценарий не опубликован — вход закрыт (`not_published`), звать некуда

  const wanted = [...await resolveAudience(tx, a.audience as Audience, a.exclude as Audience)]
  if (!wanted.length) return 0
  const people = await tx.select({ id: users.id, accessUntil: users.accessUntil })
    .from(users).where(candidateOnly(and(inArray(users.id, wanted), eq(users.status, 'active'), eq(users.candidateState, 'active'))))
  if (!people.length) return 0

  const [q] = await tx.execute(sql`select count(*)::int as n from quiz_questions where quiz_id = ${quiz.id}::uuid`) as unknown as { n: number }[]
  const minutes = interviewEstimateMinutes(quiz.questionCount || q?.n || 0, scenario)
  const due = a.dueMode === 'absolute'
    ? a.dueAt
    : a.dueMode === 'relative' && a.dueDays ? new Date(a.createdAt.getTime() + a.dueDays * 86_400_000) : null
  const url = `${process.env.APP_URL ?? ''}/interview/${quiz.id}`

  let sent = 0
  for (const p of people) {
    // Срок доступа кандидата — дата; полднем UTC, как в `candidate_invited`: не переезжает на соседний день
    const access = p.accessUntil ? new Date(`${p.accessUntil}T12:00:00Z`) : null
    const until = [due, access].filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0] ?? null
    for (const channel of INTERVIEW_INVITE_CHANNELS) {
      const ok = await enqueueNotification(tx, {
        tenantId,
        userId: p.id,
        code: 'interview_invited',
        channel,
        payload: { minutes, url, until: until?.toISOString() ?? '' },
        dedupKey: `interview_invited:${a.id}:${p.id}:${channel}`,
        refType: 'user',
        refId: p.id,
      })
      if (ok) sent++
    }
  }
  return sent
}
