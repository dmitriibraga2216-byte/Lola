import { DEFAULT_LOCALE, resolveLocale } from '../../shared/domain/dateFormat'
import type { Locale } from '../../shared/domain/dateFormat'

// Ничего не реэкспортируем из `shared/domain/dateFormat` под теми же именами — этот файл
// добавляет только `recipientLocale`. Сервисам, которым нужны `formatDate`/`formatShortDate`/
// `formatDateTime`/`formatTime`/`formatNumber`/`resolveLocale`/`Locale` — импортировать их
// напрямую из `../../shared/domain/dateFormat` относительным путём, как и `shared/domain/
// roles.ts`/`shared/schemas/settings.ts` везде в `server/**` — это проверенный рабочий способ
// (см. докблок `dateFormat.ts` о том, почему на клиенте нужен именно алиас `#shared`, а не он).

/**
 * Локаль отримувача листа/сповіщення (докс/23 §3.4, §13.4): своя — `users.locale`, інакше
 * локаль тенанта, інакше `uk`. Той самий порядок, що вже рахує `dispatchNotifications`
 * (server/services/notifications.ts) — там локаль лишена як є (вже правильна, робочий код не
 * чіпаємо), а новий серверний код форматування дат бере локаль саме через цю функцію.
 */
export function recipientLocale(userLocale: string | null | undefined, tenantLocale: string | null | undefined): Locale {
  return resolveLocale(userLocale ?? tenantLocale ?? DEFAULT_LOCALE)
}
