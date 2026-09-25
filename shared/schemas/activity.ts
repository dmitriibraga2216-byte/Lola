import { z } from 'zod'
import { isIanaTimezone } from '../domain/activity'
import type { ActivityDay } from '../domain/activity'

/**
 * Контракты ленты и карты активности (docs/v2/38-people-extensions.md §3.1, §5.1, §10; PR-34).
 * Один источник для экрана карточки и сервера (CLAUDE.md п. 7).
 */

/** `GET /people/:id/activity?year=` — год карты; без него — текущий год по часам человека. */
export const personActivityQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
})
export type PersonActivityQuery = z.infer<typeof personActivityQuerySchema>

/**
 * `users.timezone` (§3.1): IANA-пояс удалённого человека или `null` — «за точкою». Произвольную
 * строку вроде `UTC+4` не принимаем: в Postgres это POSIX-запись с обратным знаком, а человек
 * почти наверняка имел в виду UTC+4. Postgres ещё раз проверяет имя констрейнтом.
 */
export const personTimezoneSchema = z.string().trim().max(64)
  .refine(isIanaTimezone, 'Оберіть часовий пояс зі списку, наприклад Europe/Kyiv')
  .nullable()

/** Ответ `GET /people/:id/activity` — «дні · події · рівні за рік» (§10). */
export interface PersonActivityDto {
  year: number
  years: number[]
  timezone: string
  window: { from: string | null, to: string }
  scope: 'self' | 'full' | 'reviewer'
  days: ActivityDay[]
  totals: { activeDays: number, events: number, seconds: number }
}
