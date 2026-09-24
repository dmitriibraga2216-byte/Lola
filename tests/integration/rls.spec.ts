import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Два обязательных теста безопасности этапа 0 (docs/07-stages.md, docs/02-data-model.md §2.12):
 *
 * 1. Полнота RLS: нет таблицы с tenant_id без включённой и принудительной политики.
 *    Защита от забытой таблицы в новой миграции.
 * 2. Изоляция тенантов: под тенантом Б не видно ни одной строки тенанта А —
 *    перебор всех таблиц с tenant_id, в которых есть данные.
 */

const adminUrl = process.env.DATABASE_ADMIN_URL
const appUrl = process.env.DATABASE_URL

if (!adminUrl || !appUrl) {
  throw new Error('DATABASE_ADMIN_URL и DATABASE_URL должны быть заданы (см. .env.example)')
}

const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })
const app = postgres(appUrl, { max: 2, onnotice: () => {} })

let tenantTables: string[] = []
let kappiId: string
let otherId: string

beforeAll(async () => {
  const rows = await admin`
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      )
    order by c.relname
  `
  tenantTables = rows.map(r => r.table_name as string)

  const [kappi] = await admin`select id from tenants where slug = 'kappi'`
  if (!kappi) throw new Error('Сид не применён: тенант kappi не найден. Запустить pnpm db:seed')
  kappiId = kappi.id as string

  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name
    returning id
  `
  otherId = other!.id as string
})

afterAll(async () => {
  await admin.end()
  await app.end()
})

describe('полнота RLS', () => {
  it('в схеме есть таблицы с tenant_id', () => {
    expect(tenantTables.length).toBeGreaterThan(0)
  })

  it('каждая таблица с tenant_id имеет включённый и принудительный RLS с политикой', async () => {
    const broken: string[] = []
    for (const table of tenantTables) {
      const [state] = await admin`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
          exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = c.relname) as has_policy
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = ${table}
      `
      if (!state!.enabled || !state!.forced || !state!.has_policy) {
        broken.push(`${table} (enabled=${state!.enabled}, forced=${state!.forced}, policy=${state!.has_policy})`)
      }
    }
    expect(broken, `Таблицы без полного RLS: ${broken.join(', ')}`).toEqual([])
  })
})

describe('изоляция тенантов', () => {
  it('роль приложения не суперпользователь и не имеет BYPASSRLS', async () => {
    // Суперпользователь обходит RLS и с NOBYPASSRLS — одного rolbypassrls мало
    const [role] = await app`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`
    expect(role!.rolsuper).toBe(false)
    expect(role!.rolbypassrls).toBe(false)
  })

  it('под тенантом Б не видно ни одной строки тенанта А (все таблицы с данными)', async () => {
    const checked: string[] = []
    for (const table of tenantTables) {
      const [{ count: adminCount }] = await admin<[{ count: number }]>`        select count(*)::int as count from ${admin(table)} where tenant_id = ${kappiId}
      `
      if (adminCount === 0) continue
      checked.push(table)

      await app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${otherId}, true)`
        const [{ count: leaked }] = await tx<[{ count: number }]>`
          select count(*)::int as count from ${tx(table)} where tenant_id = ${kappiId}
        `
        expect(leaked, `Утечка: ${table} видна из чужого тенанта`).toBe(0)
      })
    }
    // Позитивный контроль: сид положил данные хотя бы в несколько таблиц
    expect(checked.length).toBeGreaterThanOrEqual(5)
  })

  it('под своим тенантом данные видны (позитивный контроль)', async () => {
    await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${kappiId}, true)`
      const [{ count }] = await tx<[{ count: number }]>`select count(*)::int as count from users`
      expect(count).toBeGreaterThan(0)
    })
  })

  it('вставка строки с чужим tenant_id отклоняется (with check)', async () => {
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${otherId}, true)`
        await tx`
          insert into users (tenant_id, full_name, status)
          values (${kappiId}, 'Зловмисник', 'active')
        `
      }),
    ).rejects.toThrow()
  })

  it('без контекста тенанта приложение не видит ничего', async () => {
    const [{ count }] = await app<[{ count: number }]>`select count(*)::int as count from users`
    expect(count).toBe(0)
  })
})
