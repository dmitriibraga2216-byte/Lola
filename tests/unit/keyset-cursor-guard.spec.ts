import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Сторож ключевых курсоров (`shared/domain/keyset.ts`, docs/04-api.md §4.1).
 *
 * Курсор, собранный вручную через JS `Date`, терял микросекунды `timestamptz`, и списки молча
 * теряли строки одной миллисекунды — так было в шести местах сразу (доска кандидатов, люди,
 * очередь проверки, платежи, комментарии, журналы). Этот тест не даёт вернуть такой курсор:
 * любой список обязан строить курсор через `encodeKeyset()`/`keysetAt()` и сравнивать через
 * `keysetAfter()`. Нарушение валится с файлом, строкой и объяснением.
 *
 * Правила нарочно простые — это поиск по тексту, а не разбор кода; вторая половина теста
 * показывает на исторических строках, что каждое из шести прежних мест было бы поймано.
 * Исключение — только поимённо и с причиной, по образцу `tests/unit/date-format-scan.spec.ts`.
 */

const root = resolve(__dirname, '../..')

/** Сама утилита: здесь проверка формата и есть реализация. */
const IMPLEMENTATION_FILES = new Set(['shared/domain/keyset.ts', 'shared/schemas/keyset.ts', 'server/utils/keyset.ts'])

/** `файл:правило` → почему это не нарушение. На момент введения сторожа нарушений не было. */
const EXCEPTIONS = new Map<string, string>([
  [
    'server/services/bonuses.ts:service-without-keyset',
    'журнал бонусов листается по целому `id` книги (`points_ledger.id bigserial` — порядок вставки под '
    + 'блокировкой счёта), момента времени в курсоре нет: как `/audit` и `/security-log`, «точен сам по '
    + 'себе и остаётся числом» (docs/04-api.md §4.1); keysetAfter() с `int` обрезал бы ключ до int4',
  ],
])

interface LineRule { id: string, why: string, test: (line: string) => boolean }

const DATE_CALL = /\.(toISOString|getTime|valueOf)\(|new Date\(|Date\.parse\(/

const LINE_RULES: LineRule[] = [
  {
    id: 'date-in-cursor',
    why: 'момент в курсоре прошёл через JS Date — это миллисекунды, а timestamptz хранит микросекунды; берите keysetAt() + encodeKeyset()',
    test: l => /cursor/i.test(l) && DATE_CALL.test(l),
  },
  {
    id: 'hand-made-format',
    why: 'самодельный формат курсора — разбирайте его keysetAfter()/decodeKeyset()',
    test: l => /cursor\??\.split\(/i.test(l),
  },
  {
    id: 'drizzle-compare',
    why: 'момент сравнивается с курсором мимо keysetAfter(): без второго ключа и через Date',
    test: l => /\b(lt|gt|lte|gte)\(\s*[\w.]*(At|_at)\b[^\n]*cursor/i.test(l),
  },
  {
    id: 'bare-timestamptz',
    why: 'курсор как голый timestamptz: без второго ключа строки одного момента теряются на границе страниц',
    test: l => /cursor[^\n`]*\}\s*::timestamptz/i.test(l),
  },
]

interface Violation { file: string, line: number, rule: string, why: string, snippet: string }

/** Тела функций с «Cursor» в имени — от объявления до закрывающей скобки на том же отступе. */
function cursorFunctions(lines: string[]): { name: string, from: number, body: string[] }[] {
  const out: { name: string, from: number, body: string[] }[] = []
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w*[Cc]ursor\w*)\s*[(<]/.exec(line)
    if (!m) return
    const end = lines.findIndex((l, j) => j > i && l === `${m[1]}}`)
    out.push({ name: m[2]!, from: i, body: lines.slice(i + 1, end < 0 ? undefined : end) })
  })
  return out
}

/** Все совпадения правил в файле, без учёта исключений. */
function scanRaw(file: string, src: string): Violation[] {
  if (IMPLEMENTATION_FILES.has(file)) return []
  const out: Violation[] = []
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    for (const rule of LINE_RULES) {
      if (rule.test(line)) out.push({ file, line: i + 1, rule: rule.id, why: rule.why, snippet: line.trim() })
    }
  })
  for (const fn of cursorFunctions(lines)) {
    fn.body.forEach((line, k) => {
      if (DATE_CALL.test(line)) {
        out.push({ file, line: fn.from + k + 2, rule: 'date-in-cursor-fn', why: `функция ${fn.name}() строит или читает курсор через Date — теряет микросекунды`, snippet: line.trim() })
      }
    })
  }
  // Сервис, который читает курсор из фильтра, обязан сравнивать через keysetAfter().
  if (file.startsWith('server/services/') && /\.cursor\b/.test(src) && !/\bkeysetAfter\(/.test(src)) {
    const at = lines.findIndex(l => /\.cursor\b/.test(l))
    out.push({ file, line: at + 1, rule: 'service-without-keyset', why: 'сервис читает курсор, но не сравнивает через keysetAfter()', snippet: lines[at]!.trim() })
  }
  return out
}

function scan(file: string, src: string): Violation[] {
  return scanRaw(file, src).filter(v => !EXCEPTIONS.has(`${v.file}:${v.rule}`))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.nuxt' || name === '.output') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

describe('сторож ключевых курсоров', () => {
  it('в server/, shared/ и app/ нет курсоров, собранных вручную через Date', () => {
    const files = ['server', 'shared', 'app'].flatMap(d => walk(join(root, d)))
    const violations = files.flatMap(abs => scan(relative(root, abs).replace(/\\/g, '/'), readFileSync(abs, 'utf8')))
    const report = violations.map(v => `${v.file}:${v.line} [${v.rule}] ${v.why}\n    ${v.snippet}`).join('\n')
    expect(violations, `\n${report}\n`).toEqual([])
  })

  it('каждое исключение ещё нужно: мёртвая строка списка — повод её убрать', () => {
    for (const key of EXCEPTIONS.keys()) {
      const [file, rule] = key.split(':') as [string, string]
      const hits = scanRaw(file, readFileSync(join(root, file), 'utf8')).filter(v => v.rule === rule)
      expect(hits.length, `исключение ${key} больше ничего не прикрывает`).toBeGreaterThan(0)
    }
  })
})

describe('сторож поймал бы все шесть прежних мест (строки из кода до исправления)', () => {
  const rulesOf = (file: string, src: string) => scan(file, src).map(v => v.rule)

  it('доска кандидатов: encodeCursor/decodeCursor через Date и split', () => {
    const src = [
      'export function encodeCursor(row: { createdAt: Date, id: string }): string {',
      '  return `${new Date(row.createdAt).toISOString()}|${row.id}`',
      '}',
      '',
      'export function decodeCursor(cursor?: string): { createdAt: Date, id: string } | null {',
      '  if (!cursor) return null',
      '  const [at, id] = cursor.split(\'|\')',
      '  if (!at || !id) return null',
      '  const date = new Date(at)',
      '  return Number.isNaN(date.getTime()) ? null : { createdAt: date, id }',
      '}',
    ].join('\n')
    expect(rulesOf('server/services/candidateFunnel.ts', src)).toEqual(expect.arrayContaining(['date-in-cursor-fn', 'hand-made-format']))
  })

  it('люди: курсор из getTime() и split', () => {
    const src = [
      'const [ts, id] = filter.cursor.split(\'_\')',
      'cursor: hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null,',
    ].join('\n')
    expect(rulesOf('server/services/people.ts', src)).toEqual(expect.arrayContaining(['hand-made-format', 'date-in-cursor', 'service-without-keyset']))
  })

  it('очередь проверки: submitted_at в миллисекундах', () => {
    const src = [
      'const [priority, ms, id] = filter.cursor.split(\'_\')',
      'cursor: hasMore && last ? `${last.priority}_${last.submittedAt.getTime()}_${last.id}` : null,',
    ].join('\n')
    expect(rulesOf('server/services/reviewQueue.ts', src)).toEqual(expect.arrayContaining(['hand-made-format', 'date-in-cursor']))
  })

  it('платежи и комментарии: lt(createdAt, new Date(cursor)) без второго ключа', () => {
    expect(rulesOf('server/services/billing.ts', '    query.cursor ? lt(tenantPayments.createdAt, new Date(query.cursor)) : undefined,'))
      .toEqual(expect.arrayContaining(['date-in-cursor', 'drizzle-compare', 'service-without-keyset']))
    expect(rulesOf('server/services/comments.ts', '        ...(filter.cursor ? [lt(comments.createdAt, new Date(filter.cursor))] : []),'))
      .toEqual(expect.arrayContaining(['date-in-cursor', 'drizzle-compare']))
  })

  it('журналы: курсор как голый timestamptz', () => {
    const src = '  const cursor = (col: SQL) => f.cursor ? sql`and ${col} < ${f.cursor}::timestamptz` : sql``'
    expect(rulesOf('server/services/logs.ts', src)).toEqual(expect.arrayContaining(['bare-timestamptz', 'service-without-keyset']))
  })

  it('курсор по целочисленному id (журнал аудита) — не нарушение', () => {
    const src = [
      '        ...(cursor ? [lt(auditLog.id, BigInt(cursor))] : []),',
      '    meta: { cursor: hasMore ? Number(page[page.length - 1]!.id) : null, limit },',
    ].join('\n')
    expect(scan('server/api/v1/audit.get.ts', src)).toEqual([])
  })
})
