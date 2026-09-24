import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, formatDate, formatDateTime, formatNumber, formatShortDate, formatTime, resolveLocale, SUPPORTED_LOCALES } from '../../shared/utils/dateFormat'

/**
 * Единая точка форматирования дат/времени/чисел (докс/28, долг PR-107 — «около полусотни мест
 * форматирования дат хардкодят локаль»). Эта утилита — единственное место, где вызывается
 * нативный `toLocale*String`/`toLocaleString` с реальным Intl-тегом; композабл (`app/composables/
 * useFormat.ts`) и серверная обёртка (`server/utils/formatLocale.ts`) — тонкие прокладки над ней.
 */

const SAMPLE = new Date('2026-09-24T14:05:00Z')

describe('shared/utils/dateFormat: resolveLocale', () => {
  it('пропускает поддерживаемые локали как есть', () => {
    for (const l of SUPPORTED_LOCALES) expect(resolveLocale(l)).toBe(l)
  })

  it('неизвестная, пустая или отсутствующая локаль падает на uk', () => {
    expect(resolveLocale('de')).toBe(DEFAULT_LOCALE)
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE)
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE)
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE)
  })
})

describe('shared/utils/dateFormat: одна дата — три локали, три разных написания', () => {
  it('formatDate (полная дата) отличается для uk/en/ru и не хардкодит уникальный вид', () => {
    const uk = formatDate(SAMPLE, 'uk')
    const en = formatDate(SAMPLE, 'en')
    const ru = formatDate(SAMPLE, 'ru')
    expect(uk).toBe('24 вересня 2026 р.')
    expect(en).toBe('24 September 2026')
    expect(ru).toBe('24 сентября 2026 г.')
    expect(new Set([uk, en, ru]).size).toBe(3)
  })

  it('formatShortDate — короткий формат для таблиц, день/місяць у двох цифрах під будь-яку локаль', () => {
    expect(formatShortDate(SAMPLE, 'uk')).toBe('24.09.2026')
    expect(formatShortDate(SAMPLE, 'en')).toBe('24/09/2026')
    expect(formatShortDate(SAMPLE, 'ru')).toBe('24.09.2026')
  })

  it('formatDateTime — дата і час разом, дефолтні опції', () => {
    const uk = formatDateTime(SAMPLE, 'uk')
    const en = formatDateTime(SAMPLE, 'en')
    expect(uk).toMatch(/^24\.09\.2026/)
    expect(en).toMatch(/^24\/09\/2026/)
    expect(uk).not.toBe(en)
  })

  it('formatDateTime зі своїми Intl-опціями (dateStyle/timeStyle) — опції зберігаються, локаль ні', () => {
    const uk = formatDateTime(SAMPLE, 'uk', { dateStyle: 'medium', timeStyle: 'short' })
    const en = formatDateTime(SAMPLE, 'en', { dateStyle: 'medium', timeStyle: 'short' })
    expect(uk).not.toBe(en)
  })

  it('formatTime — тільки час, однаковий вигляд під усіма локалями цього проєкту (24-годинний, HH:MM)', () => {
    expect(formatTime(SAMPLE, 'uk')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatTime(SAMPLE, 'en')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatTime(SAMPLE, 'ru')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('formatDate зі своїми опціями (день+місяць без року) — той самий набір, що і в birthdays.vue/learn/index.vue', () => {
    expect(formatDate(SAMPLE, 'uk', { day: 'numeric', month: 'long' })).toBe('24 вересня')
    expect(formatDate(SAMPLE, 'en', { day: 'numeric', month: 'long' })).toBe('24 September')
  })

  it('формат числа розділювач розрядів під локаль (обсяг сховища тощо) — кома/крапка як десятковий роздільник', () => {
    // Розділювач тисяч у uk-UA — нерозривний пробіл (U+00A0), тому звіряємо через regex,
    // а не побайтово (буквальний пробіл у джерелі тесту виглядає ідентично, але не той символ).
    expect(formatNumber(1234.5, 'uk', { maximumFractionDigits: 1 })).toMatch(/^1\s234,5$/)
    expect(formatNumber(1234.5, 'en', { maximumFractionDigits: 1 })).toBe('1,234.5')
  })
})

describe('shared/utils/dateFormat: невірна локаль на вході формату падає на uk, а не кидає виняток', () => {
  it('formatDate/formatShortDate/formatDateTime/formatTime приймають лише Locale — виклик через resolveLocale перед ними', () => {
    // Місце виклику (композабл/сервер) завжди прогонює довільний рядок через resolveLocale();
    // самі format-функції типізовані на Locale і не бачать «сирих» значень — перевіряємо саме
    // резолвер, а не тихе ковтання помилки всередині Intl.
    const raw: string | null = 'fr-FR'
    expect(formatDate(SAMPLE, resolveLocale(raw))).toBe(formatDate(SAMPLE, 'uk'))
  })
})
