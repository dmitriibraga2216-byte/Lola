import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'

/**
 * Сторож общего соединения (CLAUDE.md правила 1–2, docs/25 §5).
 *
 * `db` из `server/db/client.ts` ходит ролью `app_user` под RLS. Вне `withTenant()` у него нет
 * `app.tenant_id`, и любая таблица с `tenant_id` для него пуста: запрос не падает, а молча
 * отдаёт ноль строк, `update`/`delete` ничего не меняют. Так ломалось уже пять мест:
 * `collectUsageDue()` (22.09.2026: сбор потребления шёл каждый вызов подряд), три источника
 * кругов фоновых задач — уведомления, попытки, вебхуки — и уборщик `oauth_states` (24.09.2026:
 * круги не обслуживали ни одного тенанта).
 *
 * Правило: вызов общего `db` вне `withTenant()` касается только платформенных таблиц (без
 * `tenant_id`) и функций `SECURITY DEFINER`. Тест находит каждый вызов `db.…` в `server/` и
 * перечисляет таблицы, которых он касается, — в тексте SQL и в построителе Drizzle. Набор
 * тенантных таблиц берётся из схемы Drizzle, а не из списка в тесте: новая таблица с
 * `tenant_id` попадает под правило сама.
 *
 * Это поиск по тексту, а не разбор кода. Исключение — только поимённо и с причиной, по образцу
 * `tests/unit/keyset-cursor-guard.spec.ts`; вторая половина теста показывает на строках кода до
 * исправления, что каждое из пяти мест было бы поймано.
 */

const root = resolve(__dirname, '../..')

const TABLE_BY_EXPORT = new Map<string, string>()
const TENANT_TABLES = new Set<string>()
for (const [name, value] of Object.entries(schema)) {
  if (!is(value, PgTable)) continue
  const table = getTableName(value)
  TABLE_BY_EXPORT.set(name, table)
  if (Object.values(getTableColumns(value)).some(c => c.name === 'tenant_id')) TENANT_TABLES.add(table)
}

/** Само подключение и обёртка вокруг него: здесь общее `db` и есть `withTenant()`. */
const IMPLEMENTATION_FILES = new Set(['server/db/client.ts', 'server/utils/withTenant.ts'])

/** `файл:таблица` → почему это не нарушение. */
const EXCEPTIONS = new Map<string, string>([
  ['server/services/otp.ts:otp_codes', 'код входа выдаётся до выбора пространства: строка пишется с tenant_id = NULL, и политика otp_codes пропускает именно такие строки (миграция 0001); коды с тенантом (отклик на вакансию) идут через withTenant()'],
])

interface Violation { file: string, line: number, table: string, snippet: string }

/** Локальные имена общего `db`: `import { db } from '…/db/client'`, `{ db as x }`, `const { db } = await import('…/db/client')`. */
function sharedDbNames(src: string): string[] {
  const lists = [
    ...src.matchAll(/import\s*\{([^{}]*)\}\s*from\s*['"][^'"]*\/db\/client['"]/g),
    ...src.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"][^'"]*\/db\/client['"]\s*\)/g),
  ]
  const names = new Set<string>()
  for (const m of lists) {
    for (const part of m[1]!.split(',')) {
      const s = /^\s*db\s*(?:(?:as|:)\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part)
      if (s) names.add(s[1] ?? 'db')
    }
  }
  return [...names]
}

/**
 * Текст вызова от `db.` до конца выражения. Скобки и строки (включая `${…}` внутри шаблонных)
 * считаются; перенос строки заканчивает выражение, если следующая строка не продолжает цепочку
 * (`.from(…)`, `.where(…)`); закрывшаяся внешняя скобка, `,` и `;` — тоже конец.
 */
function callText(src: string, start: number): string {
  const stack: ({ kind: 'tpl' } | { kind: 'expr', depth: number })[] = []
  let depth = 0
  let i = start
  for (; i < src.length; i++) {
    const c = src[i]!
    const top = stack[stack.length - 1]
    if (top?.kind === 'tpl') {
      if (c === '\\') i++
      else if (c === '`') stack.pop()
      else if (c === '$' && src[i + 1] === '{') { stack.push({ kind: 'expr', depth }); depth++; i++ }
      continue
    }
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i + 1] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1 || src.length; continue }
    if (c === '`') { stack.push({ kind: 'tpl' }); continue }
    if (c === '(' || c === '[' || c === '{') { depth++; continue }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      if (top?.kind === 'expr' && depth === top.depth) { stack.pop(); continue }
      if (depth < 0) break
      continue
    }
    if (depth === 0 && stack.length === 0) {
      if (c === ';' || c === ',') break
      if (c === '\n' && !/^\s*\./.test(src.slice(i + 1))) break
    }
  }
  return src.slice(start, i)
}

/** Таблицы в тексте вызова: SQL (`from`/`join`/`into`/`update`, без вызовов функций), `${таблица}`, построитель Drizzle. */
function tablesIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(?:from|join|into|update)\s+(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)\b(?!"?\s*\()/gi)) {
    out.add(m[1]!.toLowerCase())
  }
  const byExport = [
    ...text.matchAll(/\$\{\s*(?:schema\.)?([A-Za-z_$][\w$]*)\s*\}/g),
    ...text.matchAll(/\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin|insert|update|delete)\(\s*(?:schema\.)?([A-Za-z_$][\w$]*)\s*[,)]/g),
    ...text.matchAll(/\.query\.([A-Za-z_$][\w$]*)/g),
  ]
  for (const m of byExport) {
    const table = TABLE_BY_EXPORT.get(m[1]!)
    if (table) out.add(table)
  }
  return [...out].filter(t => TENANT_TABLES.has(t))
}

/** Все обращения общего `db` к тенантным таблицам в файле, без учёта исключений. */
function scanRaw(file: string, src: string): Violation[] {
  if (IMPLEMENTATION_FILES.has(file)) return []
  const out: Violation[] = []
  for (const name of sharedDbNames(src)) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:execute|select|selectDistinct|selectDistinctOn|insert|update|delete|query|transaction|with|\\$with|\\$count)\\b`, 'g')
    for (const m of src.matchAll(call)) {
      const text = callText(src, m.index!)
      const line = src.slice(0, m.index!).split('\n').length
      for (const table of tablesIn(text)) out.push({ file, line, table, snippet: text.split('\n')[0]!.trim() })
    }
  }
  return out
}

function scan(file: string, src: string): Violation[] {
  return scanRaw(file, src).filter(v => !EXCEPTIONS.has(`${v.file}:${v.table}`))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('сторож общего соединения db', () => {
  it('набор тенантных таблиц взят из схемы: очереди фоновых задач в нём, платформенные — нет', () => {
    expect(TENANT_TABLES.size).toBeGreaterThan(100)
    for (const t of ['notifications', 'attempts', 'webhook_deliveries', 'tenant_usage', 'oauth_states', 'otp_codes']) expect(TENANT_TABLES.has(t), t).toBe(true)
    for (const t of ['tenants', 'plans', 'plan_prices', 'plan_addons', 'rate_limits', 'platform_audit']) expect(TENANT_TABLES.has(t), t).toBe(false)
  })

  it('в server/ общее db вне withTenant() не касается тенантных таблиц', () => {
    const files = walk(join(root, 'server'))
    const violations = files.flatMap(abs => scan(relative(root, abs).replace(/\\/g, '/'), readFileSync(abs, 'utf8')))
    const report = violations.map(v => `${v.file}:${v.line} — таблица ${v.table} под RLS: без app.tenant_id строк не видно. Внутри withTenant() или функцией SECURITY DEFINER (docs/25 §5)\n    ${v.snippet}`).join('\n')
    expect(violations, `\n${report}\n`).toEqual([])
  })

  it('каждое исключение ещё нужно: мёртвая строка списка — повод её убрать', () => {
    for (const key of EXCEPTIONS.keys()) {
      const [file, table] = key.split(':') as [string, string]
      const hits = scanRaw(file, readFileSync(join(root, file), 'utf8')).filter(v => v.table === table)
      expect(hits.length, `исключение ${key} больше ничего не прикрывает`).toBeGreaterThan(0)
    }
  })
})

describe('сторож поймал бы все пять прежних мест (строки из кода до исправления)', () => {
  const IMPORT = 'import { db } from \'../db/client\'\n'
  const tables = (file: string, src: string) => scan(file, src).map(v => v.table)

  it('источники кругов: уведомления, попытки (db через динамический импорт), вебхуки', () => {
    expect(tables('server/services/notifications.ts', `${IMPORT}
export async function tenantsWithQueued(): Promise<string[]> {
  const rows = await db.execute(sql\`select distinct tenant_id from notifications where status = 'queued' and scheduled_for <= now()\`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}`)).toEqual(['notifications'])
    expect(tables('server/services/attempts.ts', `
export async function tenantsWithActiveAttempts(): Promise<string[]> {
  const { db } = await import('../db/client')
  const rows = await db.execute(sql\`select distinct tenant_id from attempts where status = 'in_progress'\`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}`)).toEqual(['attempts'])
    expect(tables('server/services/webhooks.ts', `${IMPORT}
  const rows = await db.execute(sql\`select distinct tenant_id from webhook_deliveries where status = 'pending' and next_attempt_at <= now()\`)`)).toEqual(['webhook_deliveries'])
  })

  it('collectUsageDue: tenant_usage в подзапросе многострочного SQL рядом с платформенной tenants', () => {
    expect(tables('server/services/usage.ts', `${IMPORT}
  const rows = await db.execute(sql\`
    select t.id from tenants t
    where t.status = 'active'
      and extract(hour from (now() at time zone t.timezone)) = 0
      and not exists (
        select 1 from tenant_usage u where u.tenant_id = t.id
          and (u.collected_at at time zone t.timezone)::date = (now() at time zone t.timezone)::date
      )
  \`) as unknown as { id: string }[]`)).toEqual(['tenant_usage'])
  })

  it('уборщик oauth_states: delete мимо withTenant() не удаляет ничего', () => {
    expect(tables('server/services/oauth.ts', `${IMPORT}
export function cleanupStates(): Promise<unknown> {
  return db.execute(sql\`delete from oauth_states where expires_at < now() - interval '1 day'\`)
}`)).toEqual(['oauth_states'])
  })

  it('построитель Drizzle: from/join, insert/update/delete, db.query, ${таблица} в sql, псевдоним импорта', () => {
    expect(tables('server/services/x.ts', `${IMPORT}const r = await db.select({ id: users.id }).from(users).where(eq(users.status, 'active'))`)).toEqual(['users'])
    expect(tables('server/services/x.ts', `${IMPORT}const r = await db.select().from(tenants)\n  .innerJoin(schema.users, eq(schema.users.tenantId, tenants.id))`)).toEqual(['users'])
    expect(tables('server/services/x.ts', `${IMPORT}await db.update(notifications).set({ status: 'sent' })`)).toEqual(['notifications'])
    expect(tables('server/services/x.ts', `${IMPORT}await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, id))`)).toEqual(['webhook_deliveries'])
    expect(tables('server/services/x.ts', `${IMPORT}const u = await db.query.users.findFirst()`)).toEqual(['users'])
    expect(tables('server/services/x.ts', `${IMPORT}await db.execute(sql\`select count(*) from \${attempts} a\`)`)).toEqual(['attempts'])
    expect(tables('server/services/x.ts', 'import { db as appDb, type Db } from \'../db/client\'\nawait appDb.insert(otpCodes).values(row)')).toEqual(['otp_codes'])
  })

  it('не нарушение: платформенные таблицы, функции SECURITY DEFINER, работа внутри withTenant()', () => {
    expect(scan('server/services/x.ts', `${IMPORT}
const [t] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId))
const [p] = t ? await db.select().from(plans).where(eq(plans.code, t.plan)) : []
const rows = await db.execute(sql\`select * from auth_users_by_phone(\${phone})\`)
const due = await db.execute(sql\`select tenant_id from tenants_with_queued_notifications()\`)
const a = await db.execute(sql\`select id from tenants where status = 'active' and extract(hour from (now() at time zone timezone)) = 0\`)
await db.execute(sql\`delete from rate_limits where key = \${key}\`)
return withTenant(tenantId, null, tx => tx.select().from(notifications).where(eq(notifications.status, 'queued')))`)).toEqual([])
    // Своё подключение платформы (BYPASSRLS, docs/25 §7) — не общее db, даже если переменная так названа
    expect(scan('server/services/platform.ts', 'const db = platformDb()\nawait db.select().from(schema.users)')).toEqual([])
  })
})
