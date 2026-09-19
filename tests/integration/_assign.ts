import type { ContentType } from '../../shared/enums'
import type { AssignmentParams } from '../../shared/schemas/assignments'

/**
 * Правила прохождения живут только в назначении (CLAUDE.md п. 11). Тестам, которым нужен
 * тест с порогом/попытками, помогает это назначение: для конкретных людей или для всех активных.
 */
export async function assignWithParams(
  ctx: { tenantId: string, actorId: string },
  subjectType: ContentType,
  subjectId: string,
  params: AssignmentParams,
  userIds?: string[],
): Promise<string> {
  const { createAssignment } = await import('../../server/services/assignments')
  const r = await createAssignment(ctx, {
    subjectType, subjectId, lockVersion: false,
    audience: { rules: [userIds?.length ? { type: 'user', ids: userIds } : { type: 'segment', filter: {} }], match: 'any' },
    dueMode: 'none', dueDays: 14, isMandatory: false, autoSync: false, tags: [], status: 'active',
    params, reminders: { notifyOnAssign: false },
  })
  if (!r.ok) throw new Error(`assignWithParams: ${r.code}`)
  return r.assignmentId
}
