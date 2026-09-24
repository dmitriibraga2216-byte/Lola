import { and, desc, eq, sql } from 'drizzle-orm'
import { pointsLedger } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { currentRequestContext } from '../utils/requestContext'
import type { PointsCurrency, PointsEvent } from '../../shared/enums'

/**
 * Книга баллов и бонусов (docs/02 §2.10, docs/21 §14.9) — **единственный источник баланса**.
 *
 * `[решение]` Баланс не хранится отдельным полем и не кешируется: это `balance_after` последней
 * строки человека по валюте (так и в эталоне, и в подсказке мокапа Bonuses: «Баланс людини — не
 * збережене поле, а останній рядок книги»). Отдельный кеш был бы второй правдой, которую надо
 * пересобирать и сверять; последняя строка читается по индексу `(tenant_id, user_id, currency, id)`
 * так же дёшево, как строка кеша. Согласованность `balance_after` держит блокировка счёта:
 * каждая запись берёт `pg_advisory_xact_lock` по (тенант, человек, валюта), читает последнюю
 * строку и пишет следующую — две одновременные операции одного человека выстраиваются в очередь.
 * Расхождение `balance_after` с суммой `delta` — повод для алерта (`ledgerDrift`), не для правки.
 *
 * Строки не правятся и не удаляются. Списание — отрицательная строка, возврат — компенсирующая
 * положительная. Повтор события (`event` + `ref_id`) — не ошибка, а `duplicate`: уникальный
 * индекс `points_ledger_once_uq` делает начисление идемпотентным.
 */

export interface LedgerEntryInput {
  tenantId: string
  userId: string
  currency: PointsCurrency
  delta: number
  event: PointsEvent
  /** `task_completed` — назначение, `purchase`/`refund` — заказ; у `manual` нет. */
  refId?: string | null
  title?: string | null
  comment?: string | null
  actorId?: string | null
}

export type PostResult =
  | { ok: true, id: number, balanceAfter: number }
  | { ok: false, code: 'duplicate' | 'insufficient', balance: number }

/**
 * Блокировка счёта человека по валюте до конца транзакции. Повторный захват в той же транзакции
 * не блокирует (advisory-блокировки сессии складываются), поэтому вызывать можно из обёрток.
 */
export async function lockAccount(tx: TenantTx, tenantId: string, userId: string, currency: PointsCurrency): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`points_ledger:${tenantId}:${userId}:${currency}`}, 0))`)
}

/** Текущий остаток валюты — `balance_after` последней строки; нет строк — 0. */
export async function balanceOf(tx: TenantTx, userId: string, currency: PointsCurrency): Promise<number> {
  const [row] = await tx.select({ b: pointsLedger.balanceAfter }).from(pointsLedger)
    .where(and(eq(pointsLedger.userId, userId), eq(pointsLedger.currency, currency)))
    .orderBy(desc(pointsLedger.id)).limit(1)
  return row?.b ?? 0
}

/**
 * Проводка одной строки под блокировкой счёта. `insufficient` — списание увело бы остаток ниже
 * нуля (строка не пишется), `duplicate` — такое событие с этой ссылкой уже проведено.
 * Вызывающий обязан быть внутри `withTenant()`: RLS отрезает чужие строки, `tenant_id` — из сессии.
 */
export async function postEntry(tx: TenantTx, input: LedgerEntryInput): Promise<PostResult> {
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new Error('points_ledger: delta должен быть ненулевым целым')
  if ((input.event === 'manual') !== !input.refId) throw new Error('points_ledger: ссылка обязательна для всех событий, кроме manual')
  await lockAccount(tx, input.tenantId, input.userId, input.currency)
  const balance = await balanceOf(tx, input.userId, input.currency)
  if (input.refId) {
    const [dup] = await tx.select({ id: pointsLedger.id }).from(pointsLedger)
      .where(and(eq(pointsLedger.userId, input.userId), eq(pointsLedger.currency, input.currency), eq(pointsLedger.event, input.event), eq(pointsLedger.refId, input.refId)))
      .limit(1)
    if (dup) return { ok: false, code: 'duplicate', balance }
  }
  const next = balance + input.delta
  if (next < 0) return { ok: false, code: 'insufficient', balance }
  const [row] = await tx.insert(pointsLedger).values({
    tenantId: input.tenantId,
    userId: input.userId,
    currency: input.currency,
    delta: input.delta,
    balanceAfter: next,
    event: input.event,
    refId: input.refId ?? null,
    title: input.title ?? null,
    comment: input.comment ?? null,
    actorId: input.actorId ?? null,
    requestContext: currentRequestContext(), // CLAUDE.md п. 14; в фоновой задаче — null
  }).onConflictDoNothing().returning({ id: pointsLedger.id, balanceAfter: pointsLedger.balanceAfter })
  if (!row) return { ok: false, code: 'duplicate', balance }
  return { ok: true, id: row.id, balanceAfter: row.balanceAfter }
}

/**
 * Сверка книги (docs/21 §14.9): строки, у которых `balance_after` не равен нарастающей сумме
 * `delta` по человеку и валюте. Пусто — книга сходится. Вызывается ночной задачей
 * `shop.reserve_expire`; найденное уходит в лог ошибок (Sentry), а не исправляется молча.
 */
export async function ledgerDrift(tenantId: string, limit = 50): Promise<{ id: number, userId: string, currency: string, balanceAfter: number, running: number }[]> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select id, user_id, currency, balance_after, running from (
        select id, user_id, currency, balance_after,
               sum(delta) over (partition by user_id, currency order by id) as running
        from points_ledger
      ) x where running <> balance_after order by id limit ${limit}
    `) as unknown as { id: string | number, user_id: string, currency: string, balance_after: number, running: string | number }[]
    return rows.map(r => ({ id: Number(r.id), userId: r.user_id, currency: r.currency, balanceAfter: Number(r.balance_after), running: Number(r.running) }))
  })
}
