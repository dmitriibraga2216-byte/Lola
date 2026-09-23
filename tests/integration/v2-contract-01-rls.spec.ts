import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_PACKAGE_TENANT_TABLES } from './v2-package-tables'

/**
 * Контрактный тест №1 пакета `docs/v2` (`HANDOFF.md` §7.2 п. 1, `docs/v2/40-data-model-delta.md`
 * §8 тесты 1–2): каждая новая тенантная таблица пакета имеет RLS `enable` **и** `force`, а также
 * политику `tenant_isolation` с обоими условиями — `using` и `with check`. Без `force` владелец
 * таблицы обходит RLS; без `with check` вставка с чужим `tenant_id` не отклоняется.
 *
 * Список таблиц — `V2_PACKAGE_TENANT_TABLES` (`./v2-package-tables.ts`), сейчас пуст: до первой
 * миграции пакета (`docs/v2/45-plan.md`, PR-01 — этот PR, до PR-04) тест зелёный тривиально и
 * становится содержательным по мере того, как последующие PR дописывают список.
 */

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-01: RLS enable+force и политика tenant_isolation (using+with check)', () => {
  it('список таблиц пакета объявлен (может быть пуст до появления первой миграции)', () => {
    expect(Array.isArray(V2_PACKAGE_TENANT_TABLES)).toBe(true)
  })

  it('каждая таблица пакета включает RLS enable+force и политику с using и with check', async () => {
    const broken: string[] = []
    for (const table of V2_PACKAGE_TENANT_TABLES) {
      const [row] = await admin`
        select c.relname as table_name,
               c.relrowsecurity as rls_enabled,
               c.relforcerowsecurity as rls_forced,
               p.polqual is not null as has_using,
               p.polwithcheck is not null as has_with_check
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
        where n.nspname = 'public' and c.relname = ${table}
      `
      if (!row || !row.rls_enabled || !row.rls_forced || !row.has_using || !row.has_with_check) {
        broken.push(`${table} (${row ? `enable=${row.rls_enabled}, force=${row.rls_forced}, using=${row.has_using}, with_check=${row.has_with_check}` : 'таблиці немає'})`)
      }
    }
    expect(broken, `нарушения RLS: ${broken.join(', ')}`).toEqual([])
  })
})
