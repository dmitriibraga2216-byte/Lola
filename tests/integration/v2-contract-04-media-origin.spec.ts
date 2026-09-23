import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { MEDIA_ORIGINS } from '../../shared/enums'

/**
 * Контрактный тест №4 пакета `docs/v2` (`HANDOFF.md` §7.2 п. 4, `docs/v2/40-data-model-delta.md`
 * §4.2 и §8 тест 5, решение В-6 `docs/v2/44-decisions.md`): перечень `media_assets.origin` в БД
 * совпадает со списком `40` §4.2 — ни одного лишнего, ни одного потерянного значения, и по
 * колонке `origin` существует ровно один CHECK-констрейнт (два независимых чека по одной
 * колонке дают неразрешимую ошибку вставки, `38` §3.2).
 *
 * Колонка `origin` появилась миграцией `0063_v2_media_origin` (PR-12), поэтому тест стал
 * **содержательным**: условная формулировка «если колонка существует» снята, отсутствие
 * колонки теперь само по себе падение.
 *
 * Ожидаемый перечень берётся из `shared/enums.ts` (`MEDIA_ORIGINS`), а не зашит здесь
 * четвёртой копией: копий и так три — БД, `shared/enums.ts` и `docs/02` «Перечисления».
 * Первые две сверяет этот тест, вторую и третью — `schema-parity.spec.ts`; вместе они
 * замыкают кольцо, и расхождение любой валит CI (решение В-6).
 */

/** Итоговый перечень — docs/v2/40-data-model-delta.md §4.1/§4.2, 16 значений (PR-23 добавил `issue_screenshot`). */
const EXPECTED_MEDIA_ORIGINS: string[] = [...MEDIA_ORIGINS]

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

let hasOriginColumn = false

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-04: перечень media_assets.origin', () => {
  it('колонка origin существует (миграция 0063_v2_media_origin, PR-12)', async () => {
    const [row] = await admin`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'media_assets' and column_name = 'origin'
      ) as has_origin
    `
    hasOriginColumn = Boolean(row?.has_origin)
    expect(hasOriginColumn, 'PR-12 смержен — колонка media_assets.origin обязана быть').toBe(true)
  })

  it('перечень в БД совпадает со списком 40 §4.2 в обе стороны', async () => {
    expect(EXPECTED_MEDIA_ORIGINS).toHaveLength(16)
    const def = await admin`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conname = 'media_assets_origin_chk'
    `
    expect(def.length, 'констрейнт media_assets_origin_chk не найден').toBe(1)
    const actual = [...def[0]!.def.matchAll(/'([a-z_]+)'(?:::text)?/g)].map(m => m[1]!)
    const missing = EXPECTED_MEDIA_ORIGINS.filter(v => !actual.includes(v))
    const extra = actual.filter(v => !EXPECTED_MEDIA_ORIGINS.includes(v))
    expect(missing, `отсутствуют в БД: ${missing.join(', ')}`).toEqual([])
    expect(extra, `лишние в БД: ${extra.join(', ')}`).toEqual([])
  })

  it('по колонке origin существует ровно один CHECK-констрейнт', async () => {
    const [row] = await admin`
      select count(*)::int as origin_checks
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      where c.relname = 'media_assets'
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) like '%origin%'
    `
    expect(row!.origin_checks, 'должен быть ровно один CHECK по origin').toBe(1)
  })
})
