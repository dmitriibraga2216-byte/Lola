import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_PACKAGE_PLATFORM_TABLES, V2_PACKAGE_TENANT_TABLES } from './v2-package-tables'

/**
 * Контрактный тест №5 пакета `docs/v2` (`HANDOFF.md` §7.2 п. 5): расширение
 * `tests/integration/schema-parity.spec.ts` на таблицы пакета. Ни одна таблица пакета
 * (контент или нет) не должна получать колонки `attempts`, `pass_score`, `due_at`,
 * `time_limit` — правила прохождения живут в назначении (`CLAUDE.md` п. 11,
 * `docs/15-assignments.md` §14).
 *
 * Отдельный файл, а не правка существующего `schema-parity.spec.ts` (`HANDOFF.md` §7.2:
 * «по одному файлу на проверку»), но проверяет тем же запросом и тем же запрещённым
 * множеством колонок, расширенным на объединение тенантных и платформенных таблиц пакета
 * (`V2_PACKAGE_TENANT_TABLES` + `V2_PACKAGE_PLATFORM_TABLES`, `./v2-package-tables.ts`).
 * Оба списка пусты до первых миграций пакета — тест зелёный тривиально и наполняется по
 * мере появления таблиц.
 */

const FORBIDDEN = /attempts|pass_score|due_at|time_limit/

/**
 * Поимённые исключения с причиной — по образцу `CONTENT_COLUMN_EXCEPTIONS` в
 * `tests/integration/schema-parity.spec.ts`. Не ослабление проверки: правило CLAUDE.md п. 11
 * говорит о **правилах прохождения в контенте** («сколько попыток», «какой проходной балл»,
 * «до какого числа пройти»), а не о любом столбце, в имени которого встретилась подстрока.
 *
 * - `review_queue_items.sla_due_at` — срок, за который **наставник** обязан проверить работу,
 *   а не срок прохождения назначения. Колонка с тем же именем и смыслом уже существует в
 *   `workshop_submissions` (она и становится зеркалом этой, docs/v2/44 В-2); очередь — не
 *   контент и не назначение, класть её срок в `assignments.params` некуда и незачем.
 *
 * Колонки `attempts_count` из `docs/v2/37` §3.1 здесь нет: она заведена под именем
 * `attempt_no` — как в `workshop_submissions`, где тот же смысл («какая по счёту сдача»).
 */
const PACKAGE_COLUMN_EXCEPTIONS = new Set(['review_queue_items.sla_due_at'])

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('v2-contract-05: правила прохождения не в таблицах пакета', () => {
  it('ни у одной таблицы пакета нет attempts/pass_score/due_at/time_limit', async () => {
    const tables = [...V2_PACKAGE_TENANT_TABLES, ...V2_PACKAGE_PLATFORM_TABLES]
    if (tables.length === 0) return
    const cols = await admin`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = any(${tables})
    `
    const bad = cols
      .filter(c => FORBIDDEN.test(c.column_name as string))
      .map(c => `${c.table_name}.${c.column_name}`)
      .filter(k => !PACKAGE_COLUMN_EXCEPTIONS.has(k))
    expect(bad, `правила прохождения в таблице пакета: ${bad.join(', ')}`).toEqual([])
  })
})
