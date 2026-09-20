import { orgConflicts, taskAccessLog } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import type { ContentType } from '../../shared/enums'

/**
 * Писатели журналов Spec 22 (docs/22 §13.4, docs/16 §7): обращения к заданиям и конфликты оргструктуры.
 * Оба пишут `request_context` тем же хелпером, что остальные журналы (CLAUDE.md п. 14), и никогда
 * не роняют основной поток — журнал вторичен по отношению к действию.
 */

export interface TaskAccessInput {
  tenantId: string
  userId: string
  contentType: ContentType
  contentId: string
  title?: string | null
  assignmentId?: string | null
  enrollmentId?: string | null
  action?: 'open' | 'download'
}

/** Каждое открытие или скачивание задания — строка (эталон фиксирует обращение, а не первый вход). */
export async function logTaskAccess(tx: TenantTx | null, input: TaskAccessInput): Promise<void> {
  const values = {
    tenantId: input.tenantId,
    userId: input.userId,
    contentType: input.contentType,
    contentId: input.contentId,
    title: input.title ?? null,
    assignmentId: input.assignmentId ?? null,
    enrollmentId: input.enrollmentId ?? null,
    action: input.action ?? 'open',
    requestContext: currentRequestContext(),
  }
  try {
    if (tx) await tx.insert(taskAccessLog).values(values)
    else await withTenant(input.tenantId, input.userId, t => t.insert(taskAccessLog).values(values))
  }
  catch (err) {
    console.error('task_access_log write failed', err)
  }
}

export type OrgConflictKind = 'double_unit' | 'placement_replaced' | 'manager_self' | 'manager_cycle'

export interface OrgConflictInput {
  tenantId: string
  userId?: string | null
  kind: OrgConflictKind
  source?: 'manual' | 'import'
  importJobId?: string | null
  details?: Record<string, unknown>
  actorId?: string | null
}

/** Конфликт оргструктуры: эталон не падает, а пишет строку и продолжает (docs/16 §14). */
export async function logOrgConflict(tx: TenantTx, input: OrgConflictInput): Promise<void> {
  try {
    await tx.insert(orgConflicts).values({
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      kind: input.kind,
      source: input.source ?? 'manual',
      importJobId: input.importJobId ?? null,
      details: input.details ?? {},
      actorId: input.actorId ?? null,
      requestContext: currentRequestContext(),
    })
  }
  catch (err) {
    console.error('org_conflicts write failed', err)
  }
}
