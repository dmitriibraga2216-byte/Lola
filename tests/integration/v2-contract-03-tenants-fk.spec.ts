import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_PACKAGE_TENANT_TABLES } from './v2-package-tables'

/**
 * Контрактный тест №3 пакета `docs/v2` (`HANDOFF.md` §7.2 п. 3, `docs/v2/40-data-model-delta.md`
 * §8 тест 4): ни одна тенантная таблица пакета не создана без внешнего ключа на `tenants`
 * с `on delete cascade`. Без FK удаление тенанта оставляет висячие строки — обход RLS через
 * прямой SQL всё равно их видит.
 *
 * Список — `V2_PACKAGE_TENANT_TABLES` (`./v2-package-tables.ts`), пуст до появления первой
 * таблицы пакета (см. `docs/v2/45-plan.md`). Четыре отложенных FK на не-тенантные таблицы
 * (`В-13`, `docs/v2/44-decisions.md`) сюда не относятся — это отдельный контрактный тест,
 * который появится вместе с миграциями-развязками.
 */

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-03: FK на tenants с on delete cascade', () => {
  it('у каждой таблицы пакета есть FK на tenants(id) on delete cascade', async () => {
    const broken: string[] = []
    for (const table of V2_PACKAGE_TENANT_TABLES) {
      const [row] = await admin`
        select exists (
          select 1
          from pg_constraint con
          join pg_class child on child.oid = con.conrelid
          join pg_class parent on parent.oid = con.confrelid
          where con.contype = 'f'
            and child.relname = ${table}
            and parent.relname = 'tenants'
            and con.confdeltype = 'c'
        ) as has_fk
      `
      if (!row || !row.has_fk) broken.push(table)
    }
    expect(broken, `без FK на tenants (on delete cascade): ${broken.join(', ')}`).toEqual([])
  })
})
