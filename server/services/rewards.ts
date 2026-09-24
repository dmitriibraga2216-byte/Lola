import { eq } from 'drizzle-orm'
import { assignments, users } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { DEFAULT_TASK_REWARDS } from '../../shared/domain/gamification'
import type { TaskReward } from '../../shared/domain/gamification'
import type { ContentType } from '../../shared/enums'
import { CONTENT_TYPES } from '../../shared/enums'
import type { RewardRulesPatch } from '../../shared/schemas/settings'
import { readSettings, updateGamification } from './settings'
import { postEntry } from './pointsLedger'
import { EMPLOYEE, personById } from './repo/people'
import { stageCan } from './lifecycle'
import { subjectStage } from './taskParams'
import { enqueueNotification } from './notifications'

/**
 * Правила нарахування балів і бонусів (docs/21 §3.7, §7.5; docs/15 §14.3 «Нагороди»).
 *
 * **За що** — так, как у эталона: за **виконання завдання**, то есть назначения (событие журнала
 * «Виконання завдання», docs/21 §14.9, «Деталі» — название задания), плюс ручное начисление
 * («Керування бонусами»). Чтение статьи из базы знаний или тренировочный тест без назначения —
 * не задание: за них ничего не начисляется, иначе валюту можно было бы «накрутить» просмотрами.
 *
 * **Сколько** — из параметров назначения («Бали/Бонуси за виконання завдання», docs/15 §14.3);
 * если назначение своих чисел не задало, — правило тенанта по типу контенту
 * (`settings.gamification.taskRewards`, умолчания `DEFAULT_TASK_REWARDS`). Ровно так же
 * параметры теста наследуют `learning.quizDefaults` (`taskParams.ts`). Явный `0` в назначении —
 * «без нагороды», а не «по правилу».
 *
 * **Кому** — только сотруднику (инвариант 17: кандидат баллов не копит). Баллы рейтинга — только
 * если этап курса «влияет на рейтинг» (`counts_in_rating`, docs/v2/33 §3.3); бонусы — только при
 * включённом модуле «Бонуси і магазин».
 *
 * **Сколько раз** — один раз на человека и назначение: ссылка строки книги — назначение, а
 * уникальный индекс `points_ledger_once_uq` не даёт начислить повторно ни при повторном
 * прохождении, ни при повторном вызове хука.
 */

export interface Ctx { tenantId: string, actorId: string }

/** Правило по типу контента из настроек тенанта. */
export function ruleFor(taskRewards: Record<ContentType, TaskReward>, contentType: ContentType): TaskReward {
  return taskRewards[contentType] ?? DEFAULT_TASK_REWARDS[contentType]
}

/** Правило тенанта для типа контента — подсказка в форме параметров назначения. */
export async function rewardRuleFor(tx: TenantTx, tenantId: string, contentType: ContentType): Promise<TaskReward> {
  const settings = await readSettings(tx, tenantId)
  return ruleFor(settings.gamification.taskRewards, contentType)
}

export interface AccrualResult { points: number, bonuses: number, bonusBalance: number | null }

/**
 * Начисление за выполненное задание — из единого хука `onTaskCompleted` (taskCompletion.ts),
 * в транзакции модуля. Ничего не делает, если задания нет (контент без назначения, узел
 * программы, траектория) или назначение — на другой контент.
 */
export async function accrueTaskRewards(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  input: { contentType: string, contentId: string, assignmentId: string | null },
): Promise<AccrualResult | null> {
  if (!input.assignmentId || !(CONTENT_TYPES as readonly string[]).includes(input.contentType)) return null
  const contentType = input.contentType as ContentType
  const [a] = await tx.select({ subjectType: assignments.subjectType, subjectId: assignments.subjectId, params: assignments.params, title: assignments.title })
    .from(assignments).where(eq(assignments.id, input.assignmentId))
  // Назначение на программу, а завершился её курс — это шаг, а не задание: нагорода — за программу
  if (!a || a.subjectType !== contentType || a.subjectId !== input.contentId) return null
  const [person] = await personById(tx, { kind: users.kind }, userId)
  if (person?.kind !== EMPLOYEE) return null

  const settings = await readSettings(tx, tenantId)
  const rule = ruleFor(settings.gamification.taskRewards, contentType)
  const params = (a.params ?? {}) as { points?: number | null, bonuses?: number | null }
  const stage = await subjectStage(tx, contentType, a.subjectId)
  const points = stageCan(stage, 'counts_in_rating') ? (params.points ?? rule.points) : 0
  const bonuses = settings.modules.bonuses ? (params.bonuses ?? rule.bonuses) : 0

  const out: AccrualResult = { points: 0, bonuses: 0, bonusBalance: null }
  if (points > 0) {
    const r = await postEntry(tx, { tenantId, userId, currency: 'points', delta: points, event: 'task_completed', refId: input.assignmentId, title: a.title })
    if (r.ok) out.points = points
  }
  if (bonuses > 0) {
    const r = await postEntry(tx, { tenantId, userId, currency: 'bonuses', delta: bonuses, event: 'task_completed', refId: input.assignmentId, title: a.title })
    if (r.ok) {
      out.bonuses = bonuses
      out.bonusBalance = r.balanceAfter
      // docs/23 Г-23.1 «Бонусы»: bonus.earned (код — snake_case, как у остальных шаблонов)
      await enqueueNotification(tx, { tenantId, userId, code: 'bonus_earned', payload: { amount: bonuses, title: a.title, balance: r.balanceAfter, url: '/learn/bonuses' }, dedupKey: `bonus_earned:${r.id}` })
    }
  }
  return out
}

/** Экран «Правила нарахування»: текущие правила, умолчания платформы и состояние модуля бонусов. */
export async function rewardRules(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await readSettings(tx, ctx.tenantId)
    return { taskRewards: s.gamification.taskRewards, defaults: DEFAULT_TASK_REWARDS, bonusesEnabled: s.modules.bonuses }
  })
}

export async function updateRewardRules(ctx: Ctx, patch: RewardRulesPatch) {
  await updateGamification(ctx, patch)
  return rewardRules(ctx)
}
