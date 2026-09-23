import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_PACKAGE_TENANT_TABLES } from './v2-package-tables'

/**
 * Контрактный тест №2 пакета `docs/v2` (`HANDOFF.md` §7.2 п. 2, `docs/v2/40-data-model-delta.md`
 * §8 тест 3): каждая тенантная таблица пакета имеет индекс, начинающийся с `tenant_id`, и он не
 * частичный (или частичный плюс полный рядом). Частичный индекс без полного двойника не
 * покрывает обычные списочные запросы и провоцирует полный скан по всем тенантам разом.
 *
 * Список — `V2_PACKAGE_TENANT_TABLES` (`./v2-package-tables.ts`), пуст до появления первой
 * таблицы пакета (см. `docs/v2/45-plan.md`).
 */

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-02: tenant-first непартиальный индекс', () => {
  it('у каждой таблицы пакета есть непартиальный индекс, начинающийся с tenant_id', async () => {
    const broken: string[] = []
    for (const table of V2_PACKAGE_TENANT_TABLES) {
      const [row] = await admin`
        select exists (
          select 1
          from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid
                             and a.attname = 'tenant_id'
                             and a.attnum > 0
                             and not a.attisdropped
          where n.nspname = 'public'
            and c.relname = ${table}
            and i.indkey[0] = a.attnum
            and i.indpred is null
            and i.indisvalid
        ) as has_full_tenant_index
      `
      if (!row || !row.has_full_tenant_index) broken.push(table)
    }
    expect(broken, `без полного tenant-first индекса: ${broken.join(', ')}`).toEqual([])
  })
})
