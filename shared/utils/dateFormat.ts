/**
 * Единая точка форматирования дат/времени/чисел под активную локаль (докс/28, долг PR-107 —
 * `docs/v2/46-progress.md`, запись 2026-09-23: «около полусотни мест… игнорируют активную
 * локаль»). Чистые функции без Vue/Nitro API — ими пользуются и `app/composables/useFormat.ts`
 * (локаль из `useI18n()`), и `server/utils/formatLocale.ts` (локаль получателя
 * `users.locale ?? tenants.locale ?? 'uk'`, как в `dispatchNotifications`). Новый язык
 * интерфейса — правка `SUPPORTED_LOCALES`/`LOCALE_TAGS` в одном месте, а не обход всех экранов.
 */

export type Locale = 'uk' | 'en' | 'ru'
export const SUPPORTED_LOCALES = ['uk', 'en', 'ru'] as const satisfies readonly Locale[]
export const DEFAULT_LOCALE: Locale = 'uk'

/**
 * BCP-47 теги для Intl. `en` → `en-GB`, не `en-US`: порядок день/місяць узгоджений з коротким
 * форматом дати (`formatShortDate`) — інакше `03.04` читалося б по-різному в uk/en в одній
 * таблиці. Той самий вибір, що і в п'яти місцях, які вже галузилися по локалі до PR-107.
 */
const LOCALE_TAGS: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB', ru: 'ru-RU' }

/** Нормалізує довільний рядок локалі до підтримуваної; порожньо чи невідомо — `uk`. */
export function resolveLocale(value: string | null | undefined): Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? (value as Locale) : DEFAULT_LOCALE
}

function tagOf(locale: Locale): string {
  return LOCALE_TAGS[locale] ?? LOCALE_TAGS[DEFAULT_LOCALE]
}

export type DateInput = Date | string | number

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

const SHORT_DATE_OPTS: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }
const LONG_DATE_OPTS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
const DATE_TIME_OPTS: Intl.DateTimeFormatOptions = { ...SHORT_DATE_OPTS, ...TIME_OPTS }

/**
 * Дата, за замовчуванням розгорнута — «24 вересня 2026». Свій набір Intl-опцій — для варіантів
 * (тільки місяць, тільки день тижня, день+місяць без року тощо), локаль завжди береться з
 * параметра, а не хардкодиться викликом.
 */
export function formatDate(value: DateInput, locale: Locale, opts: Intl.DateTimeFormatOptions = LONG_DATE_OPTS): string {
  return toDate(value).toLocaleDateString(tagOf(locale), opts)
}

/** Коротка дата для таблиць і списків, формат фіксований — «24.09.2026». */
export function formatShortDate(value: DateInput, locale: Locale): string {
  return toDate(value).toLocaleDateString(tagOf(locale), SHORT_DATE_OPTS)
}

/** Дата + час, за замовчуванням «24.09.2026, 14:05»; свій набір опцій — де вже був dateStyle/timeStyle. */
export function formatDateTime(value: DateInput, locale: Locale, opts: Intl.DateTimeFormatOptions = DATE_TIME_OPTS): string {
  return toDate(value).toLocaleString(tagOf(locale), opts)
}

/** Тільки час — «14:05». */
export function formatTime(value: DateInput, locale: Locale, opts: Intl.DateTimeFormatOptions = TIME_OPTS): string {
  return toDate(value).toLocaleTimeString(tagOf(locale), opts)
}

/** Число з розділювачами розрядів під локаль (наприклад обсяг сховища в ГБ). */
export function formatNumber(value: number, locale: Locale, opts?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(tagOf(locale), opts)
}
