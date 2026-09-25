/**
 * Ключевой (keyset) курсор постраничных списков — docs/04-api.md §4.1 «Пагинация».
 *
 * Курсор — непрозрачная для клиента строка: base64url от JSON-массива значений ключа сортировки
 * последней показанной строки, например `["2026-09-24T09:00:00.123456Z","3f6c…"]`. Клиент его
 * не разбирает и не строит — только возвращает то, что прислал сервер.
 *
 * **Момент времени в курсоре — текст из Postgres с микросекундами, а не JS `Date`.**
 * `timestamptz` хранит микросекунды, `Date` — миллисекунды. Курсор `…09:00:00.123Z` вместо
 * `…09:00:00.123456Z` в предикате следующей страницы молча выбрасывал все строки между `.123000`
 * и `.123456` (сортировка по убыванию) или отдавал ту же страницу по кругу (по возрастанию).
 * Поэтому момент читается из базы уже текстом (`keysetAt()` в `server/utils/keyset.ts`), лежит
 * в курсоре как есть и сравнивается в SQL как `timestamptz` — ни в одной точке он не проходит
 * через `Date`. Кодировщик это проверяет: момент без шести знаков микросекунд (то есть сделанный
 * через `toISOString()`) он не примет.
 *
 * Модуль без зависимостей от Node и БД: его же зовёт zod-схема (`shared/schemas/keyset.ts`),
 * чтобы битый курсор отсекался на входе ответом 400, а не превращался в первую страницу.
 */

/** Вид значения в ключе: момент (`timestamptz` текстом), uuid, целое `int4`, id текстом. */
export type KeysetPart = 'at' | 'uuid' | 'int' | 'text'

export type KeysetShape = readonly KeysetPart[]

type ValueOf<P> = P extends 'int' ? number : string

/** Значения ключа в порядке `shape`: `['at', 'uuid']` → `[string, string]`. */
export type KeysetValues<S extends KeysetShape> = { -readonly [K in keyof S]: ValueOf<S[K]> }

/**
 * Ключи сортировки всех списков с курсором — одно место, откуда их берут и схема входа, и сервис.
 * Порядок частей совпадает с `order by` списка; направление у всех частей одно (разнонаправленная
 * часть приводится знаком, как `-priority` в очереди проверки).
 */
export const KEYSETS = {
  /** Канбан воронки, колонка: `created_at desc, id desc` (docs/v2/28 §5.2). */
  candidateBoard: ['at', 'uuid'],
  /** Люди: `created_at desc, id desc` (docs/16 §5.1). */
  people: ['at', 'uuid'],
  /** Очередь проверки: `-priority, submitted_at, id` по возрастанию (docs/v2/37 §10). */
  reviewQueue: ['int', 'at', 'uuid'],
  /** История платежей тенанта: `created_at desc, id desc` (docs/v2/35 §5.3). */
  payments: ['at', 'uuid'],
  /** Лента комментариев: `created_at desc, id desc` (docs/10 §14.2). */
  comments: ['at', 'uuid'],
  /**
   * Журналы: `created_at desc, id::text desc`. Id — текстом: у журнала безопасности он `bigint`,
   * у протокола статусов строки приходят из трёх таблиц сразу.
   */
  logs: ['at', 'text'],
  /**
   * Очередь «Звіт про помилки»: `reports_count desc, trusted desc, last_reported_at desc, id desc`
   * (docs/v2/36 §5.3, §7.11; PR-24). `trusted` — 1, если среди заявителей есть «надійний»:
   * при равном числе жалоб его карточка выше.
   */
  contentIssues: ['int', 'int', 'at', 'uuid'],
  /** Библиотека модулей и палитра вставки: `updated_at desc, id desc` (docs/v2/31 §5.1). */
  libraryModules: ['at', 'uuid'],
  /**
   * Лента заметок о человеке: `is_pinned desc, created_at desc, id desc` (docs/v2/38 §5.1, PR-32).
   * Закреплённые (≤ 3) всегда первыми — договорённость о развитии не тонет под новыми записями.
   */
  personNotes: ['int', 'at', 'uuid'],
  /**
   * Реестр и корзина хранилища (docs/v2/34 §5.1, §5.2): `created_at desc, id desc`, в корзине —
   * `deleted_at desc, id desc` (в `pending_delete` дата удаления обязательна, `media_assets_purge_chk`).
   */
  storageFiles: ['at', 'uuid'],
  /** Снимки оргструктуры: `created_at desc, id desc` (docs/v2/32 §5.1 «Знімки», PR-31). */
  orgSnapshots: ['at', 'uuid'],
} as const satisfies Record<string, KeysetShape>

/** Ровно такой текст отдаёт `keysetAt()`: UTC, ISO 8601, шесть знаков микросекунд. */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEXT_RE = /^[0-9A-Za-z_-]{1,64}$/
const INT4_MAX = 2_147_483_647

/** Потолок длины курсора. Самый длинный ключ — три части очереди проверки, около ста символов. */
export const KEYSET_CURSOR_MAX = 256

/**
 * Момент из курсора — настоящая дата календаря в диапазоне, который примет `timestamptz`.
 * Регулярки мало: `Date.parse` молча переносит 31 февраля в 3 марта, а Postgres на таком
 * значении падает — битый курсор дал бы 500 вместо 400.
 */
function isAt(v: unknown): v is string {
  if (typeof v !== 'string' || !AT_RE.test(v) || Number(v.slice(0, 4)) < 1) return false
  const ms = Date.parse(v)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 23) === v.slice(0, 23)
}

function fits(part: KeysetPart, v: unknown): boolean {
  switch (part) {
    case 'at': return isAt(v)
    case 'uuid': return typeof v === 'string' && UUID_RE.test(v)
    case 'int': return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= INT4_MAX
    case 'text': return typeof v === 'string' && TEXT_RE.test(v)
  }
}

function toBase64Url(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)))
  }
  catch {
    return null
  }
}

/**
 * Курсор по значениям ключа последней строки страницы. Значение не того вида — ошибка программы:
 * чаще всего это момент, прошедший через `Date` (`toISOString()` даёт три знака, а не шесть).
 */
export function encodeKeyset<S extends KeysetShape>(shape: S, values: KeysetValues<S>): string {
  const list = values as readonly unknown[]
  if (list.length !== shape.length || !shape.every((part, i) => fits(part, list[i]))) {
    throw new Error(`keyset: значения ${JSON.stringify(list)} не подходят к ключу [${shape.join(', ')}] — момент берите из keysetAt(), а не из Date`)
  }
  return toBase64Url(JSON.stringify(list))
}

/** Значения ключа из курсора или `null`, если курсор битый, чужой или от другого ключа. */
export function decodeKeyset<S extends KeysetShape>(shape: S, cursor: string | null | undefined): KeysetValues<S> | null {
  if (!cursor || cursor.length > KEYSET_CURSOR_MAX) return null
  const json = fromBase64Url(cursor)
  if (json === null) return null
  let list: unknown
  try {
    list = JSON.parse(json)
  }
  catch {
    return null
  }
  if (!Array.isArray(list) || list.length !== shape.length || !shape.every((part, i) => fits(part, list[i]))) return null
  return list as KeysetValues<S>
}
