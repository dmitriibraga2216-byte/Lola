import { sql } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'
import { decodeKeyset } from '../../shared/domain/keyset'
import type { KeysetPart, KeysetShape } from '../../shared/domain/keyset'

/**
 * SQL-половина ключевого курсора (формат и проверка — `shared/domain/keyset.ts`,
 * правило — docs/04-api.md §4.1).
 *
 * Вся работа с моментом времени — в Postgres: `keysetAt()` читает его текстом с микросекундами,
 * `keysetAfter()` сравнивает с тем же текстом, приведённым обратно к `timestamptz`. Ни в одной
 * точке значение не становится JS `Date` — ровно на этом переходе курсор терял микросекунды,
 * а следующая страница — строки.
 */

/**
 * Момент строки для курсора — UTC, ISO 8601, ровно шесть знаков микросекунд. Кладётся в select
 * рядом с данными страницы, уходит в `encodeKeyset()` как есть и наружу не отдаётся.
 */
export function keysetAt(col: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * Значение из курсора как параметр с приведением к типу ключа. Момент идёт через `::text`:
 * иначе Postgres объявит параметр `timestamptz`, и драйвер сериализует строку своим
 * сериализатором дат — у postgres.js без Drizzle это `new Date(x).toISOString()`, те же
 * миллисекунды. Через `text` строка доходит до базы нетронутой при любом клиенте.
 */
function param(part: KeysetPart, value: string | number): SQL {
  switch (part) {
    case 'at': return sql`${value}::text::timestamptz`
    case 'uuid': return sql`${value}::uuid`
    case 'int': return sql`${value}::int`
    case 'text': return sql`${value}::text`
  }
}

/**
 * Предикат «строго после курсора» для `order by k1 <dir>, k2 <dir>, …` — сравнение строк
 * `(k1, k2, …) < (v1, v2, …)` (или `>` по возрастанию), которое план берёт индексом по ключу.
 * Без курсора — `undefined`: первая страница, условие не нужно.
 *
 * Все части ключа сортируются в одном направлении; часть с обратным направлением приводится
 * знаком и в `order by`, и здесь (`-priority` очереди проверки).
 *
 * Битый курсор сюда не доходит: его отсекает схема входа (`keysetCursorSchema`) ответом 400.
 * Если всё же дошёл — это ошибка программы (курсор от другого списка), а не ввода.
 */
export function keysetAfter(shape: KeysetShape, cursor: string | null | undefined, keys: readonly (AnyColumn | SQL)[], dir: 'asc' | 'desc'): SQL | undefined {
  if (!cursor) return undefined
  const values = decodeKeyset(shape, cursor)
  if (!values || keys.length !== shape.length) {
    throw new Error(`keyset: курсор не подходит к ключу [${shape.join(', ')}] этого списка`)
  }
  const row = sql.join(keys.map(k => sql`${k}`), sql`, `)
  const after = sql.join(shape.map((part, i) => param(part, values[i]!)), sql`, `)
  return dir === 'desc' ? sql`(${row}) < (${after})` : sql`(${row}) > (${after})`
}
