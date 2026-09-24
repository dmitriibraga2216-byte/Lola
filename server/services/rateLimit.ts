import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Счётчики в БД (docs/01-roles.md §1.5), окно фиксированное.
 * Атомарный upsert: истёкшее окно начинается заново, живое — инкрементится.
 * Возвращает true, если действие разрешено.
 */
export async function hitRateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into rate_limits (key, count, reset_at)
    values (${key}, 1, now() + make_interval(secs => ${windowSec}))
    on conflict (key) do update set
      count = case when rate_limits.reset_at < now() then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at < now()
                      then now() + make_interval(secs => ${windowSec})
                      else rate_limits.reset_at end
    returning count
  `)
  const count = Number((rows as unknown as { count: number }[])[0]!.count)
  return count <= limit
}

/** Проверка без инкремента: активна ли блокировка. */
export async function isBlocked(key: string): Promise<boolean> {
  const rows = await db.execute(sql`
    select count from rate_limits where key = ${key} and reset_at > now()
  `)
  return (rows as unknown as { count: number }[]).length > 0
}

/** Поставить блокировку на windowSec (например, телефон после 5 неверных кодов). */
export async function setBlock(key: string, windowSec: number): Promise<void> {
  await db.execute(sql`
    insert into rate_limits (key, count, reset_at)
    values (${key}, 1, now() + make_interval(secs => ${windowSec}))
    on conflict (key) do update set
      count = 1, reset_at = now() + make_interval(secs => ${windowSec})
  `)
}

/**
 * Как `hitRateLimit`, но отдаёт номер попытки в окне — экрану нужен остаток попыток
 * («Залишилось спроб: 2»), а не только «можно / нельзя». Окно то же, фиксированное.
 */
export async function hitRateLimitCount(key: string, windowSec: number): Promise<number> {
  const rows = await db.execute(sql`
    insert into rate_limits (key, count, reset_at)
    values (${key}, 1, now() + make_interval(secs => ${windowSec}))
    on conflict (key) do update set
      count = case when rate_limits.reset_at < now() then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at < now()
                      then now() + make_interval(secs => ${windowSec})
                      else rate_limits.reset_at end
    returning count
  `)
  return Number((rows as unknown as { count: number }[])[0]!.count)
}

/** Сбросить счётчик — после удачной попытки неудачи до неё не копятся против человека. */
export async function clearRateLimit(key: string): Promise<void> {
  await db.execute(sql`delete from rate_limits where key = ${key}`)
}
