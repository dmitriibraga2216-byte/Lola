import { expireShopReservations } from '../services/shop'
import { ledgerDrift } from '../services/pointsLedger'

/** Час суток (по TZ процесса — Europe/Kyiv), в который проход заодно сверяет книгу. */
export const LEDGER_CHECK_HOUR = 4

/**
 * `shop.reserve_expire` одного тенанта (docs/21 Г-21.1: «Резерв живёт 14 дней, потом автоотмена
 * с уведомлением»). Планировщик pg-boss раскладывает задачу по тенантам кругом `runPerTenant`
 * (docs/25 §5): падение одного тенанта не трогает остальных, приостановленные пропускаются.
 *
 * Раз в сутки (проход в `LEDGER_CHECK_HOUR`) — сверка книги (docs/21 §14.9: «расхождение между
 * balance_after и суммой delta — повод для алерта, а не для тихой правки»): найденные строки
 * уходят в лог ошибок (Sentry подхватывает console.error), книга не правится. Ежечасно полный
 * проход по книге не нужен: расхождение не исчезает само и дождётся ночи.
 */
export async function shopReserveExpireTenant(tenantId: string, now = new Date(), checkLedger = now.getHours() === LEDGER_CHECK_HOUR): Promise<{ expired: number, drift: number }> {
  const expired = await expireShopReservations(tenantId, now)
  const drift = checkLedger ? await ledgerDrift(tenantId) : []
  if (drift.length) console.error(`[points_ledger.drift] ${tenantId}: balance_after не сходится с суммой delta`, drift.slice(0, 10))
  return { expired, drift: drift.length }
}
