import { DEFAULT_LOCALE, resolveLocale } from '../../shared/utils/dateFormat'
import type { Locale } from '../../shared/utils/dateFormat'

// Ничего не реэкспортируем из `shared/utils/dateFormat` под теми же именами: Nuxt авто-импортирует
// `shared/utils/**` и на клиенте, и на сервере, и повторный экспорт тех же имён отсюда даёт
// предупреждение о дублирующемся авто-импорте при `nuxt prepare`. Сервисам, которым нужны
// `formatDate`/`formatShortDate`/`formatDateTime`/`formatTime`/`formatNumber`/`resolveLocale`/
// `Locale` — импортировать их напрямую из `shared/utils/dateFormat` (относительным путём —
// алиас `#shared` собирает только сама Nuxt/Nitro, plain vitest его не резолвит).

/**
 * Локаль отримувача листа/сповіщення (докс/23 §3.4, §13.4): своя — `users.locale`, інакше
 * локаль тенанта, інакше `uk`. Той самий порядок, що вже рахує `dispatchNotifications`
 * (server/services/notifications.ts) — там локаль лишена як є (вже правильна, робочий код не
 * чіпаємо), а новий серверний код форматування дат бере локаль саме через цю функцію.
 */
export function recipientLocale(userLocale: string | null | undefined, tenantLocale: string | null | undefined): Locale {
  return resolveLocale(userLocale ?? tenantLocale ?? DEFAULT_LOCALE)
}
