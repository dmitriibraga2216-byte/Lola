import { describe, expect, it } from 'vitest'
import { KEYSETS, KEYSET_CURSOR_MAX, decodeKeyset, encodeKeyset } from '../../shared/domain/keyset'
import { keysetCursorSchema } from '../../shared/schemas/keyset'
import { candidateBoardSchema } from '../../shared/schemas/candidates'
import { personListQuerySchema } from '../../shared/schemas/people'
import { reviewQueueQuerySchema } from '../../shared/schemas/review'
import { tenantPaymentsQuerySchema } from '../../shared/schemas/billing'
import { commentsQuerySchema } from '../../shared/schemas/catalog'
import { logFilterSchema } from '../../shared/schemas/reports'

/**
 * Формат ключевого курсора (`shared/domain/keyset.ts`, docs/04-api.md §4.1) — без БД.
 * Что курсор не теряет строки на живой базе, проверяет `tests/integration/keyset-cursor.spec.ts`.
 */

const ID = '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f'
const AT = '2026-09-24T09:00:00.123456Z'

describe('ключевой курсор: кодирование', () => {
  it('туда и обратно без потерь — момент с микросекундами', () => {
    const cursor = encodeKeyset(KEYSETS.people, [AT, ID])
    expect(decodeKeyset(KEYSETS.people, cursor)).toEqual([AT, ID])
    const queue = encodeKeyset(KEYSETS.reviewQueue, [-5, AT, ID])
    expect(decodeKeyset(KEYSETS.reviewQueue, queue)).toEqual([-5, AT, ID])
    const log = encodeKeyset(KEYSETS.logs, [AT, '9007199254740991'])
    expect(decodeKeyset(KEYSETS.logs, log)).toEqual([AT, '9007199254740991'])
  })

  it('курсор непрозрачный и годится в адрес без экранирования', () => {
    const cursor = encodeKeyset(KEYSETS.reviewQueue, [-2147483647, AT, ID])
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cursor).not.toContain(AT)
    expect(cursor.length).toBeLessThanOrEqual(KEYSET_CURSOR_MAX)
  })

  it('момент, прошедший через Date, кодировщик не принимает: в нём миллисекунды, а не микросекунды', () => {
    const viaDate = new Date(AT).toISOString() // '2026-09-24T09:00:00.123Z' — ровно тот баг
    expect(() => encodeKeyset(KEYSETS.candidateBoard, [viaDate, ID])).toThrow(/keysetAt/)
    expect(() => encodeKeyset(KEYSETS.candidateBoard, [String(new Date(AT).getTime()), ID])).toThrow()
  })

  it('значение не того вида — ошибка программы, а не молчаливый курсор', () => {
    expect(() => encodeKeyset(KEYSETS.people, [AT, 'не-uuid'])).toThrow()
    expect(() => encodeKeyset(KEYSETS.reviewQueue, [1.5, AT, ID])).toThrow()
    expect(() => encodeKeyset(KEYSETS.reviewQueue, [2 ** 31, AT, ID])).toThrow()
  })
})

describe('ключевой курсор: разбор чужого ввода', () => {
  it('пустой курсор — первая страница', () => {
    expect(decodeKeyset(KEYSETS.people, undefined)).toBeNull()
    expect(decodeKeyset(KEYSETS.people, null)).toBeNull()
    expect(decodeKeyset(KEYSETS.people, '')).toBeNull()
  })

  it('курсоры прежних форматов не читаются: они несут миллисекунды', () => {
    expect(decodeKeyset(KEYSETS.candidateBoard, `2026-09-24T09:00:00.123Z|${ID}`)).toBeNull() // доска
    expect(decodeKeyset(KEYSETS.people, `1790240400123_${ID}`)).toBeNull() // люди
    expect(decodeKeyset(KEYSETS.reviewQueue, `0_1790240400123_${ID}`)).toBeNull() // очередь
    expect(decodeKeyset(KEYSETS.payments, '2026-09-24T09:00:00.123Z')).toBeNull() // платежи, комментарии
    expect(decodeKeyset(KEYSETS.logs, '2026-09-24 09:00:00.123456+00')).toBeNull() // журналы
  })

  it('курсор с моментом в миллисекундах, собранный вручную, тоже не читается', () => {
    const forged = btoa(JSON.stringify(['2026-09-24T09:00:00.123Z', ID])).replace(/=+$/, '')
    expect(decodeKeyset(KEYSETS.people, forged)).toBeNull()
  })

  it('курсор другого ключа не подходит', () => {
    const people = encodeKeyset(KEYSETS.people, [AT, ID])
    expect(decodeKeyset(KEYSETS.reviewQueue, people)).toBeNull()
    const queue = encodeKeyset(KEYSETS.reviewQueue, [0, AT, ID])
    expect(decodeKeyset(KEYSETS.people, queue)).toBeNull()
  })

  it('невозможная дата отсекается здесь, а не падает в Postgres', () => {
    const bad = ['2026-02-31T00:00:00.000000Z', '2026-09-24T24:00:00.000000Z', '2026-13-01T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z']
    for (const at of bad) {
      const forged = btoa(JSON.stringify([at, ID])).replace(/=+$/, '')
      expect(decodeKeyset(KEYSETS.people, forged), at).toBeNull()
    }
  })

  it('мусор, не-JSON, не-массив и слишком длинный курсор — null', () => {
    expect(decodeKeyset(KEYSETS.people, 'без-разделителя')).toBeNull()
    expect(decodeKeyset(KEYSETS.people, '%%%')).toBeNull()
    expect(decodeKeyset(KEYSETS.people, btoa('{"at":1}'))).toBeNull()
    expect(decodeKeyset(KEYSETS.people, btoa('not json').replace(/=+$/, ''))).toBeNull()
    expect(decodeKeyset(KEYSETS.people, 'A'.repeat(KEYSET_CURSOR_MAX + 1))).toBeNull()
    expect(decodeKeyset(KEYSETS.logs, btoa(JSON.stringify([AT, "1' or '1'='1"])))).toBeNull()
  })
})

describe('поле cursor в схемах списков: битый курсор — 400, а не первая страница', () => {
  const lists = [
    ['канбан', candidateBoardSchema, KEYSETS.candidateBoard, [AT, ID]],
    ['люди', personListQuerySchema, KEYSETS.people, [AT, ID]],
    ['очередь проверки', reviewQueueQuerySchema, KEYSETS.reviewQueue, [0, AT, ID]],
    ['платежи', tenantPaymentsQuerySchema, KEYSETS.payments, [AT, ID]],
    ['комментарии', commentsQuerySchema, KEYSETS.comments, [AT, ID]],
    ['журналы', logFilterSchema, KEYSETS.logs, [AT, '42']],
  ] as const

  it.each(lists)('%s: свой курсор принимается, прежний формат и мусор — нет', (_name, schema, shape, values) => {
    const own = encodeKeyset(shape, values as never)
    expect(schema.safeParse({ cursor: own }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ cursor: '' }).success, 'пустой курсор — первая страница').toBe(true)
    expect(schema.safeParse({ cursor: `2026-09-24T09:00:00.123Z|${ID}` }).success).toBe(false)
    expect(schema.safeParse({ cursor: '2026-09-24T09:00:00.123Z' }).success).toBe(false)
    expect(schema.safeParse({ cursor: 'x'.repeat(81) }).success).toBe(false)
  })

  it('ошибка объясняет, что делать', () => {
    const r = keysetCursorSchema(KEYSETS.people).safeParse('битий')
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]!.message).toMatch(/оновіть список/)
  })
})
