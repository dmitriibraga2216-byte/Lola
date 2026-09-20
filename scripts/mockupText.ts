/**
 * Извлечение «заметных текстов» мокапа (docs/28 «visual-mockups»): заголовки h1–h3, кнопки
 * и капслок-чипы/лейблы колонок. Используется скриптом снятия эталонов (mockup-shots.ts) и
 * визуальным тестом (tests/visual/screens.spec.ts) для структурных проверок по мокапу —
 * без этого пришлось бы вручную дублировать список текстов в тесте и держать его в синхроне.
 *
 * Данные в мокапах (имена, числа, даты) — примеры и не переносятся (docs/31, шапка), поэтому
 * из выборки исключаются строки из одних цифр и слишком длинные/короткие куски.
 */
const UA_UPPER = 'А-ЯЄІЇҐ'

export function extractMockupTexts(html: string): string[] {
  const out = new Set<string>()
  const add = (raw: string) => {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (t.length < 2 || t.length > 40) return
    if (/^\d+([.,]\d+)?\s*%?$/.test(t)) return // голые числа/проценты — не в счёт
    out.add(t)
  }
  for (const m of html.matchAll(/<h[123][^>]*>([^<]+)/gi)) add(m[1]!)
  for (const m of html.matchAll(/<button[^>]*>([^<]+)/gi)) add(m[1]!)
  // Капслок-чипы и заголовки колонок (СТВОРЕНО, У ПРОЦЕСІ) — в мокапах не выделены классом,
  // только инлайн-стилем, поэтому берём по регистру текста.
  const upperRe = new RegExp(`>([${UA_UPPER}][${UA_UPPER} '’ʼ0-9.\\-]{1,28})<`, 'g')
  for (const m of html.matchAll(upperRe)) add(m[1]!)
  return [...out]
}
