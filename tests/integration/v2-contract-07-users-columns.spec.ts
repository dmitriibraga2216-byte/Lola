import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Контрактный тест №7 пакета `docs/v2` (`docs/v2/40-data-model-delta.md` §8 тест 7; план `45` PR-40):
 * ни одна колонка `users` не добавлена дважды. Прямого запроса на это нет — Postgres второй `add column`
 * не пропустит, — поэтому тест, как и предписывает `40` §8, ставится **на состав**: `users` — единственная
 * таблица, которую меняют два документа (`28` и `38`), и её колонки пакета перечислены поимённо.
 *
 * По факту колонок пакета **18**, а не 16 из `40` §3.2: PR-14 (#102, `0068_v2_candidates_funnel`) добавил
 * `candidate_state_at` (от него считает авто-архив воронки, `28` §11) и `anonymized_at` (отметка стирания ПД
 * по истёкшему согласию). Расхождение записано в `docs/v2/40` §2.13. `hired_at` — колонка базового ТЗ
 * (`02` §2.3, тип `date`); пакет её не добавляет и не переопределяет (`28` §3.2, `38` §3.1).
 *
 * Состав сверяется в обе стороны — с базой и с миграциями пакета: новая колонка `users` в миграции пакета
 * без строки здесь валит тест так же, как пропавшая.
 */

/** Колонки `users`, которые добавляют миграции пакета, → миграция. */
const PACKAGE_USERS_COLUMNS: Record<string, string> = {
  kind: '0056_v2_users_kind',
  candidate_state: '0064_v2_candidates',
  candidate_status_id: '0064_v2_candidates',
  source: '0064_v2_candidates',
  source_detail: '0064_v2_candidates',
  recruiter_id: '0064_v2_candidates',
  access_until: '0064_v2_candidates',
  comm_language: '0064_v2_candidates',
  resume_asset_id: '0064_v2_candidates',
  converted_from_candidate_at: '0064_v2_candidates',
  consent_given_at: '0064_v2_candidates',
  consent_expires_at: '0064_v2_candidates',
  candidate_state_at: '0068_v2_candidates_funnel',
  anonymized_at: '0068_v2_candidates_funnel',
  vacancy_id: '0072_v2_users_vacancy_fk',
  timezone: '0093_v2_user_activity',
  rating_pct: '0094_v2_person_rating',
  rating_updated_at: '0094_v2_person_rating',
}

/** `docs/v2/40` §3.2 — 16 колонок документа; две сверх — факт PR-14. */
const DOC_40_USERS_COLUMNS = [
  'kind', 'candidate_state', 'candidate_status_id', 'source', 'source_detail', 'vacancy_id', 'recruiter_id',
  'access_until', 'comm_language', 'resume_asset_id', 'converted_from_candidate_at', 'consent_given_at',
  'consent_expires_at', 'rating_pct', 'rating_updated_at', 'timezone',
]

const MIGRATIONS_DIR = resolve(__dirname, '../../server/db/migrations')

/** `alter table users add column …` во всех миграциях пакета (`NNNN_v2_*.sql`): колонка → миграции. */
function usersColumnsAddedByPackage(): Map<string, string[]> {
  const added = new Map<string, string[]>()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_v2_.+\.sql$/.test(f)).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '')
    for (const stmt of sql.matchAll(/alter\s+table\s+(?:only\s+)?(?:"?public"?\.)?"?users"?\s+([^;]+)/gi)) {
      for (const col of stmt[1]!.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        const name = col[1]!.toLowerCase()
        added.set(name, [...(added.get(name) ?? []), file.replace(/\.sql$/, '')])
      }
    }
  }
  return added
}

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-07: колонки пакета в users — состав, ни одной дважды', () => {
  it('18 колонок пакета: 16 из 40 §3.2 и две сверх (PR-14)', () => {
    const cols = Object.keys(PACKAGE_USERS_COLUMNS)
    expect(cols).toHaveLength(18)
    expect(DOC_40_USERS_COLUMNS.filter(c => !cols.includes(c)), 'колонка 40 §3.2 потерялась').toEqual([])
    expect(cols.filter(c => !DOC_40_USERS_COLUMNS.includes(c)).sort()).toEqual(['anonymized_at', 'candidate_state_at'])
  })

  it('миграции пакета добавляют в users ровно эти колонки, каждую один раз и там, где указано', () => {
    const added = usersColumnsAddedByPackage()
    const twice = [...added].filter(([, files]) => files.length > 1).map(([c, files]) => `${c}: ${files.join(', ')}`)
    expect(twice, 'колонка users добавлена двумя миграциями пакета').toEqual([])
    expect([...added.keys()].sort(), 'состав колонок users в миграциях пакета').toEqual(Object.keys(PACKAGE_USERS_COLUMNS).sort())
    for (const [col, file] of Object.entries(PACKAGE_USERS_COLUMNS)) expect(added.get(col), col).toEqual([file])
  })

  it('в базе есть все 18 колонок пакета', async () => {
    const rows = await admin`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'users' and column_name in ${admin(Object.keys(PACKAGE_USERS_COLUMNS))}`
    expect(rows.map(r => r.column_name as string).sort()).toEqual(Object.keys(PACKAGE_USERS_COLUMNS).sort())
  })

  it('hired_at — ровно одна, базовая, тип date; пакет её не добавляет', async () => {
    const rows = await admin`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'users' and column_name = 'hired_at'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.data_type).toBe('date')
    expect(usersColumnsAddedByPackage().has('hired_at'), 'миграция пакета добавляет hired_at').toBe(false)
  })
})
