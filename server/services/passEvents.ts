import { passEvents } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'

/**
 * Протокол змін статусу проходження програми або траєкторії (docs/33 D-045; docs/22 §13.4).
 * Пишется в той же транзакции, что и смена статуса (`program_enrollments` / `trajectory_enrollments`),
 * по аналогии с `enrollment_events` у записей на курс: событие + {from, to, result, reason, source}.
 * Журнал `task-status` (`logs.ts`) объединяет `enrollment_events` ∪ `attempt_results` ∪ `pass_events`.
 * Запись вторична по отношению к действию — ошибка журнала не ломает прохождение.
 */

export type PassSubject = 'training_program' | 'trajectory'
export type PassEvent = 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'reset'

export interface PassEventInput {
  subjectType: PassSubject
  subjectId: string
  enrollmentId: string
  userId: string
  event: PassEvent
  /** Статус до и после (пять enrollment_status, CLAUDE.md п. 12), результат в %, причина снятия, источник зачисления. */
  payload?: { from?: string | null, to?: string | null, result?: number | string | null, reason?: string | null, source?: string | null }
  actorId?: string | null
}

export async function logPassEvent(tx: TenantTx, tenantId: string, input: PassEventInput): Promise<boolean> {
  try {
    const p = input.payload ?? {}
    const result = p.result == null || Number.isNaN(Number(p.result)) ? null : Math.round(Number(p.result))
    await tx.insert(passEvents).values({
      tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      enrollmentId: input.enrollmentId,
      userId: input.userId,
      event: input.event,
      payload: { from: p.from ?? null, to: p.to ?? null, result, reason: p.reason ?? null, source: p.source ?? null },
      actorId: input.actorId ?? null,
      requestContext: currentRequestContext(),
    })
    return true
  }
  catch (err) {
    console.error('pass_events write failed', err)
    return false
  }
}

/** Событие по переходу статуса: done → completed, failed → failed, in_progress из not_started → started, иначе — reset/created. */
export function eventForTransition(from: string | null, to: string): PassEvent | null {
  if (from === to) return null
  if (to === 'done') return 'completed'
  if (to === 'failed') return 'failed'
  if (to === 'in_progress') return 'started'
  if (to === 'not_started') return from === null || from === 'not_assigned' ? 'created' : 'reset'
  return null
}
