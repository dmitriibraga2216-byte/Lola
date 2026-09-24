import { formatDate, formatDateTime, formatNumber, formatShortDate, formatTime, resolveLocale } from '../../shared/utils/dateFormat'
import type { DateInput } from '../../shared/utils/dateFormat'

/**
 * Єдина точка форматування дат/часу/чисел на екранах (докс/28, долг PR-107): бере активну
 * локаль з `useI18n()`, а не хардкодить `uk-UA`, як робили ~50 місць в `app/pages/**` до цієї
 * правки. Сама логіка форматів і мапа локалей — `shared/utils/dateFormat.ts`, тут лише
 * прив'язка до поточної локалі інтерфейсу.
 */
export function useFormat() {
  const { locale } = useI18n()
  const loc = () => resolveLocale(locale.value)
  return {
    /** Дата, за замовчуванням «24 вересня 2026»; другий аргумент — свій набір Intl-опцій. */
    formatDate: (value: DateInput, opts?: Intl.DateTimeFormatOptions) => formatDate(value, loc(), opts),
    /** Коротка дата для таблиць і списків — «24.09.2026». */
    formatShortDate: (value: DateInput) => formatShortDate(value, loc()),
    /** Дата + час, за замовчуванням «24.09.2026, 14:05». */
    formatDateTime: (value: DateInput, opts?: Intl.DateTimeFormatOptions) => formatDateTime(value, loc(), opts),
    /** Тільки час — «14:05». */
    formatTime: (value: DateInput, opts?: Intl.DateTimeFormatOptions) => formatTime(value, loc(), opts),
    /** Число з розділювачами розрядів під локаль. */
    formatNumber: (value: number, opts?: Intl.NumberFormatOptions) => formatNumber(value, loc(), opts),
  }
}
