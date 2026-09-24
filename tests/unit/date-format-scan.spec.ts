import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Долг PR-107 (docs/v2/46-progress.md, запись 2026-09-23): «около полусотни мест форматирования
 * дат хардкодят локаль (toLocaleDateString('uk-UA', …) и подобное), не глядя на выбранный язык».
 * Все такие места переведены на `shared/domain/dateFormat.ts` (через `useFormat()` на клиенте,
 * `server/utils/formatLocale.ts` на сервере) — этот тест не даёт долгу вернуться: любой новый
 * вызов `toLocale*String`/`Intl.*Format` с локалью-строковым литералом в `app/` или `server/`
 * (кроме самой утилиты) валится с указанием файла и строки.
 *
 * Исключения — именованный список ниже с причиной для каждого (по образцу
 * `CONTENT_COLUMN_EXCEPTIONS` в `tests/integration/schema-parity.spec.ts`): места, где вызов
 * не форматирует дату для показа человеку, а конвертирует момент времени в таймзону через
 * трюк `toLocaleString('en-US', { timeZone })` — единственный способ сделать это без внешней
 * библиотеки. Часовой пояс явно не входит в задачу правки (см. CLAUDE.md, п. 5 задания).
 */

const root = resolve(__dirname, '../..')

/** Файлы самой утилиты — здесь литеральные Intl-теги ('uk-UA' и т.п.) являются реализацией, не долгом. */
const IMPLEMENTATION_FILES = new Set(['shared/domain/dateFormat.ts'])

/**
 * `file:method:локаль-літерал` — привязка к конкретному методу и конкретному хардкод-значению
 * в файле, а не ко всему файлу целиком: другой хардкод (иная локаль или иной метод) в том же
 * файле тест всё равно поймает. Оба случая в `notifications.ts` — один и тот же трюк
 * (`toLocaleString('en-US', { timeZone })`), встречающийся в файле дважды под одним ключом.
 */
const EXCEPTIONS = new Map<string, string>([
  [
    "server/services/notifications.ts:toLocaleString:en-US",
    'scheduleWithQuietHours + nextOccurrence — перевод «текущего момента» в таймзону тенанта/рассылки '
    + '(docs/03 §3.10, docs/23 §13.2.1) через toLocaleString(\'en-US\', { timeZone }), не показ даты человеку',
  ],
  [
    "server/services/reportBuilder.ts:toLocaleString:en-US",
    'scheduledReportsScan — день тижня по Києву для розкладу звіту, той самий трюк з таймзоною',
  ],
  [
    "server/services/reportBuilder.ts:DateTimeFormat:en-GB",
    'scheduledReportsScan — час по Києву для порівняння з розкладом звіту, не показ дати',
  ],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.nuxt' || name === '.output') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** Метод форматирования дати/часу з рядковим літералом як першим аргументом — сама ознака хардкоду. */
const CALL_RE = /\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*(['"])((?:(?!\2).)*)\2/g
/** `new Intl.DateTimeFormat('...')` / `Intl.NumberFormat('...')` / `Intl.RelativeTimeFormat('...')` з літералом. */
const INTL_RE = /Intl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat)\(\s*(['"])((?:(?!\2).)*)\2/g

interface Violation { file: string, method: string, locale: string, snippet: string }

function findViolations(files: string[]): Violation[] {
  const out: Violation[] = []
  for (const abs of files) {
    const relPath = relative(root, abs).replace(/\\/g, '/')
    if (IMPLEMENTATION_FILES.has(relPath)) continue
    const src = readFileSync(abs, 'utf8')
    for (const re of [CALL_RE, INTL_RE]) {
      for (const m of src.matchAll(re)) {
        out.push({ file: relPath, method: m[1]!, locale: m[3]!, snippet: m[0] })
      }
    }
  }
  return out
}

const keyOf = (v: Violation) => `${v.file}:${v.method}:${v.locale}`

describe('дати/час/числа: жодного хардкоду локалі поза shared/domain/dateFormat.ts', () => {
  const files = [...walk(join(root, 'app')), ...walk(join(root, 'server')), ...walk(join(root, 'shared'))]

  it('сканер реально знаходить файли (не порожній прогін)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('усі знайдені виклики або переведені на єдину утиліту, або є в іменованому списку винятків', () => {
    const found = findViolations(files)
    const unexpected = found.filter(v => !EXCEPTIONS.has(keyOf(v)))
    const details = unexpected.map(v => `${v.file}: ${v.snippet}`).join('\n')
    expect(unexpected, `хардкод локалі поза утилітою:\n${details}`).toEqual([])
  })

  it('усі оголошені винятки досі існують у коді (список не встиг протухнути)', () => {
    const found = new Set(findViolations(files).map(keyOf))
    const stale = [...EXCEPTIONS.keys()].filter(k => !found.has(k))
    expect(stale, `винятки, яких більше немає в коді — прибрати зі списку:\n${stale.join('\n')}`).toEqual([])
  })
})
