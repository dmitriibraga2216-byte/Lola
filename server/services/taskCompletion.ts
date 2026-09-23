import { and, desc, eq } from 'drizzle-orm'
import { taskStatusLog } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import type { ContentType } from '../../shared/enums'
import { findAssignmentFor } from './taskParams'
import { confirmAssignmentCompetencies } from './developmentExtra'
import { advanceLifecycleTx } from './lifecycleState'

/**
 * Єдина точка «завдання завершено» для всіх типів контенту (docs/33 D-020, D-034; docs/15 §14, docs/22 §13.4).
 *
 * Досі завершення фіксувалося в кожному модулі по-своєму: курс — `enrollments.status`, тест —
 * `attempts`, заняття — `meetup_session_registrations`, опитування — `survey_participations`,
 * а ресурс, оголошення, чек-лист, анкета і практикум записи прохождення не мали зовсім. Через це
 * підтвердження компетенцій призначення (`assignment_competencies`, docs/19 Г-19.2) працювало
 * лише для курсу, а звіт по типу контенту — лише для курсу/програми/тесту.
 *
 * Хук робить одне й те саме для кожного типу:
 *   1. знаходить призначення (передане або новіше активне, в аудиторії якого людина —
 *      `findAssignmentFor`, як при старті спроби);
 *   2. пише рядок у `task_status_log` (status `done | failed` — із п'яти `enrollment_status`,
 *      CLAUDE.md п. 12; повтор того самого статусу по тій самій парі «людина × контент/призначення»
 *      не дублюється — це журнал змін, а не звернень);
 *   3. при `done` і наявному призначенні підтверджує прив'язані компетенції — у тій самій транзакції.
 *
 * Хук викликається всередині транзакції модуля, що фіксує завершення (`tx`), або сам відкриває
 * `withTenant` (`completeTask`). Ніколи не кидає назовні — журнал вторинний щодо дії.
 */

export type TaskStatus = 'done' | 'failed'

export type TaskSourceKind
  = 'enrollment' | 'attempt' | 'complex_attempt' | 'resource_view' | 'meetup_attendance' | 'notice_ack'
    | 'survey_response' | 'assessment_cycle' | 'checklist_run' | 'workshop_submission' | 'program_enrollment' | 'trajectory_enrollment'

/** Тип у журналі: одинадцять `content_type` + `notice` + `trajectory` (траєкторія завершується так само, хоч і не призначається як контент). */
export type TaskLogContentType = ContentType | 'trajectory'

export interface TaskCompletion {
  contentType: TaskLogContentType
  contentId: string
  status: TaskStatus
  /** Результат на момент завершення (%, бали) — як `enrollments.score`. */
  result?: number | null
  assignmentId?: string | null
  enrollmentId?: string | null
  sourceKind: TaskSourceKind
  sourceId?: string | null
  /** Хто зафіксував (наставник, спостерігач); null — сама людина або система. */
  actorId?: string | null
}

export interface TaskCompletionResult {
  /** Рядок записано (false — той самий статус уже був останнім). */
  logged: boolean
  assignmentId: string | null
  /** Скільки компетенцій підтверджено (docs/19 Г-19.2). */
  competencies: number
}

const NONE: TaskCompletionResult = { logged: false, assignmentId: null, competencies: 0 }

/** Хук усередині транзакції модуля. */
export async function onTaskCompleted(tx: TenantTx, tenantId: string, userId: string, input: TaskCompletion): Promise<TaskCompletionResult> {
  try {
    let assignmentId = input.assignmentId ?? null
    if (!assignmentId && input.contentType !== 'trajectory') {
      assignmentId = (await findAssignmentFor(tx, input.contentType, input.contentId, userId))?.id ?? null
    }
    const [last] = await tx.select({ status: taskStatusLog.status, assignmentId: taskStatusLog.assignmentId })
      .from(taskStatusLog)
      .where(and(eq(taskStatusLog.tenantId, tenantId), eq(taskStatusLog.userId, userId), eq(taskStatusLog.contentType, input.contentType), eq(taskStatusLog.contentId, input.contentId)))
      .orderBy(desc(taskStatusLog.createdAt)).limit(1)
    if (last && last.status === input.status && (last.assignmentId ?? null) === assignmentId) {
      return { logged: false, assignmentId, competencies: 0 }
    }
    await tx.insert(taskStatusLog).values({
      tenantId,
      userId,
      contentType: input.contentType,
      contentId: input.contentId,
      assignmentId,
      enrollmentId: input.enrollmentId ?? null,
      status: input.status,
      result: input.result == null || Number.isNaN(Number(input.result)) ? null : String(Math.round(Number(input.result) * 100) / 100),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null,
      actorId: input.actorId ?? null,
      requestContext: currentRequestContext(),
    })
    let competencies = 0
    if (input.status === 'done' && assignmentId) {
      competencies = await confirmAssignmentCompetencies(tx, tenantId, userId, assignmentId, input.sourceId ?? input.enrollmentId ?? null)
    }
    // `lifecycle.advance` (docs/v2/33 §11): переход человека на следующий этап проверяется
    // по событию завершения назначения — здесь, в единой точке, а не в каждом модуле.
    // Не переводит, пока открыто хоть одно обязательное назначение текущего этапа (§7.6).
    if (input.status === 'done') await advanceLifecycleTx(tx, tenantId, userId)
    return { logged: true, assignmentId, competencies }
  }
  catch (err) {
    console.error('task_status_log write failed', err)
    return NONE
  }
}

/** Той самий хук у власній транзакції — для місць, де завершення фіксується поза транзакцією модуля. */
export async function completeTask(tenantId: string, userId: string, input: TaskCompletion): Promise<TaskCompletionResult> {
  return withTenant(tenantId, userId, tx => onTaskCompleted(tx, tenantId, userId, input)).catch((err) => {
    console.error('task completion hook failed', err)
    return NONE
  })
}

/** Останній зафіксований статус людини по контенту (для звітів по типах без власного запису прохождення). */
export async function lastTaskStatus(tx: TenantTx, tenantId: string, userId: string, contentType: TaskLogContentType, contentId: string) {
  const [row] = await tx.select({ status: taskStatusLog.status, result: taskStatusLog.result, createdAt: taskStatusLog.createdAt, assignmentId: taskStatusLog.assignmentId })
    .from(taskStatusLog)
    .where(and(eq(taskStatusLog.tenantId, tenantId), eq(taskStatusLog.userId, userId), eq(taskStatusLog.contentType, contentType), eq(taskStatusLog.contentId, contentId)))
    .orderBy(desc(taskStatusLog.createdAt)).limit(1)
  return row ?? null
}
