import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

/**
 * Инвариант 17 для конструктора отчётов (П-16.1 `docs/v2/39`, В-8 `docs/v2/44`): итоговый SQL
 * каждой сущности `ENTITIES` (`server/services/reportBuilder.ts`) называет вид людей.
 *
 * Почему не сканер исходников. Запрос конструктора собирается из фрагментов: `from` живёт в
 * описании сущности (`sql\`users u …\``, `join users u on u.id = e.user_id`), `where` — в
 * `runReport()`, и ни одна строка исходника сама по себе не «выборка людей». Сканер слоя 2
 * (`tests/integration/users-kind-filter.spec.ts`) такие места не видит по построению — и три
 * сущности прожили без фильтра с появления `users.kind` (PR #91). Здесь проверяется то, что
 * уходит в базу: `runReport()` выполняется с подменённой транзакцией, которая запоминает запрос
 * вместо выполнения, и запрос переводится в текст тем же диалектом, что у драйвера. Базы тест
 * не требует.
 *
 * Правило. `users` — источник строк (`from users`, `join users`) → в том же SQL есть предикат
 * вида для его алиаса, и вид совпадает с объявленным `kind` сущности. Исключение одно:
 * `left join users x on x.id = …` — обогащение именем, людей в выборку оно не добавляет (В-8).
 * Сущность с `kind: null` («строки не люди») не берёт строки из `users` вовсе.
 */

const captured = vi.hoisted(() => [] as SQL[])
vi.mock('../../server/utils/withTenant', () => ({
  withTenant: async (_tenantId: string, _actorId: string | null, fn: (tx: unknown) => unknown) =>
    fn({ execute: async (q: SQL) => { captured.push(q); return [] } }),
}))

const { ENTITIES, runReport } = await import('../../server/services/reportBuilder')
const dialect = new PgDialect()

type Kind = 'employee' | 'candidate'
const KIND_PREDICATE = (alias: string) => new RegExp(`\\b${alias}\\.kind\\s*=\\s*'(employee|candidate)'`, 'g')
/** `users` как источник строк; алиас — если он есть и это не следующее ключевое слово. */
const SOURCE = /\b(left\s+(?:outer\s+)?join|join|from)\s+users\b(?:\s+(?:as\s+)?(?!(?:where|on|join|left|inner|cross|group|order|limit|union)\b)(\w+))?/gi

/** Нарушения правила из шапки для одного SQL-текста; пустой массив — запрос чист. */
function kindViolations(text: string, declared: Kind | null | undefined): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SOURCE)) {
    const [whole, op, alias] = m
    const rest = text.slice(m.index! + whole.length)
    if (/^left/i.test(op!) && alias && new RegExp(`^\\s+on\\s+${alias}\\.id\\s*=`, 'i').test(rest)) continue
    if (declared === null) {
      out.push(`«${whole.trim()}»: сущность объявлена без людей (kind: null), но берёт строки из users`)
      continue
    }
    const found = alias
      ? [...text.matchAll(KIND_PREDICATE(alias))].map(k => k[1] as Kind)
      : [...(rest.split(')')[0] ?? '').matchAll(/\bkind\s*=\s*'(employee|candidate)'/g)].map(k => k[1] as Kind)
    if (!found.length) out.push(`«${whole.trim()}»: нет предиката вида${alias ? ` ${alias}.kind` : ''}`)
    else if (declared === undefined) out.push(`«${whole.trim()}»: вид не объявлен в описании сущности (поле kind)`)
    else if (found.some(k => k !== declared)) out.push(`«${whole.trim()}»: предикат вида ${found.join(', ')} ≠ объявленному ${declared}`)
  }
  return out
}

describe('правило проверки само ловит нарушение (иначе зелёный цвет ничего не значит)', () => {
  it.each([
    ['список людей без вида', `select u.full_name from users u`, 'employee', 1],
    ['записи на курс, соединённые с людьми, без вида', `select u.full_name from enrollments e join users u on u.id = e.user_id`, 'employee', 1],
    ['вид назван для алиаса строки', `select u.full_name from enrollments e join users u on u.id = e.user_id where true and u.kind = 'employee'`, 'employee', 0],
    ['подзапрос с видом', `select u.full_name from (select * from users where kind = 'employee') u`, 'employee', 0],
    ['вид не тот, что объявлен', `select u.full_name from users u where u.kind = 'candidate'`, 'employee', 1],
    ['вид есть в SQL, но не объявлен в описании', `select u.full_name from users u where u.kind = 'employee'`, undefined, 1],
    ['left join ради имени — не источник строк', `select rs.day, u.full_name from reviewer_stats_daily rs left join users u on u.id = rs.reviewer_id`, null, 0],
    ['«строки не люди», но выборка из users', `select u.full_name from users u`, null, 1],
  ] as const)('%s', (_name, text, kind, n) => {
    expect(kindViolations(text, kind as Kind | null | undefined)).toHaveLength(n)
  })
})

describe('итоговый SQL каждой сущности конструктора называет вид людей (инвариант 17)', () => {
  const entities = Object.entries(ENTITIES) as [keyof typeof ENTITIES, { kind?: Kind | null, fields: Record<string, unknown> }][]
  const ctx = { tenantId: '00000000-0000-0000-0000-000000000001', actorId: '00000000-0000-0000-0000-000000000002' }

  /** Все пути `runReport()`: таблица, группировка, область видимости, фильтр — каждый свой запрос. */
  async function queriesOf(entity: keyof typeof ENTITIES, fields: string[]): Promise<string[]> {
    captured.length = 0
    await runReport(ctx, { entity, fields }, 10, null)
    await runReport(ctx, { entity, fields, groupBy: fields[0] }, 10, null)
    await runReport(ctx, { entity, fields }, 10, ['00000000-0000-0000-0000-000000000003'])
    await runReport(ctx, { entity, fields, filters: { status: 'active' } }, 10, [])
    return captured.map(q => dialect.sqlToQuery(q).sql)
  }

  it('сущностей не меньше трёх исходных — иначе проверять нечего', () => {
    expect(entities.map(([k]) => k)).toEqual(expect.arrayContaining(['people', 'enrollments', 'attempts']))
  })

  it.each(entities)('%s', async (entity, def) => {
    const texts = await queriesOf(entity, Object.keys(def.fields))
    expect(texts, 'runReport() не дошёл до запроса — проверка была бы пустой').toHaveLength(4)
    const violations = texts.flatMap(t => kindViolations(t, def.kind))
    expect([...new Set(violations)], `сущность «${entity}»`).toEqual([])
  })

  it('три сущности по штату объявлены как employee и действительно выбирают людей', async () => {
    for (const entity of ['people', 'enrollments', 'attempts'] as const) {
      expect((ENTITIES[entity] as { kind?: unknown }).kind, entity).toBe('employee')
      const [text] = await queriesOf(entity, ['full_name'])
      expect(text, `${entity}: источник людей потерялся — правило стало бы пустым`).toMatch(/\b(from|join)\s+users\s+u\b/)
      expect(text).toMatch(/\bu\.kind\s*=\s*'employee'/)
    }
  })
})
