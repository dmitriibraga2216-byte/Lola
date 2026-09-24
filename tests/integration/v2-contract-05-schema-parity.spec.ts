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
 *
 * Исключения — только поимённые и только с обоснованием (`PACKAGE_COLUMN_EXCEPTIONS` ниже).
 */

const FORBIDDEN = /attempts|pass_score|due_at|time_limit/

/**
 * Поимённые исключения с причиной — по образцу `CONTENT_COLUMN_EXCEPTIONS` в
 * `tests/integration/schema-parity.spec.ts`. Не ослабление проверки: правило CLAUDE.md п. 11
 * говорит о **правилах прохождения в контенте** («сколько попыток», «какой проходной балл»,
 * «до какого числа пройти»), а не о любом столбце, в имени которого встретилась подстрока.
 *
 * - `review_queue_items.sla_due_at` — срок, за который **наставник** обязан проверить работу,
 *   а не срок прохождения назначения. До PR-20 тот же смысл нёс зеркальный
 *   `workshop_submissions.sla_due_at` (docs/v2/44 В-2); PR-20 зеркало сняла, очередь осталась
 *   единственным владельцем этого срока. Очередь — не контент и не назначение, класть её срок
 *   в `assignments.params` некуда и незачем.
 * - `content_issues.due_at` — срок, к которому **автор чинит дефект** (`36` §7.6: 2 рабочих
 *   дня blocking, 7 normal, 30 cosmetic). Это SLA очереди правок, а не дедлайн прохождения:
 *   карточка живёт у методиста, человек, подавший жалобу, этого срока не видит вовсе.
 * - `content_issues.rescored_attempts` — сколько попыток **уже пересчитано** по карточке
 *   (`36` §7.8). Счётчик выполненной работы, а не разрешённое число попыток: разрешённое
 *   по-прежнему только в `assignments.params.attemptsAllowed`.
 *
 * - `review_delegations.due_at` — срок, к которому **делегат** обязан проверить переданную
 *   работу (`37` §3.2, §6.1, §7.5), не позже срока проверки элемента. Это срок проверяющего,
 *   а не дедлайн прохождения: проверяемый человек его не видит и на него не влияет.
 * - `review_sla_events.due_at` — снимок `review_queue_items.sla_due_at` на момент события SLA
 *   (`37` §3.4): журнал срока проверки, того же смысла, что и исключённый выше `sla_due_at`.
 * - `storage_pending_uploads.attempts` — сколько раз **устройство пыталось дослать файл**
 *   (`34` §3.3, §7.5 п. 3: `storage.pending_upload_retry` выдаёт место и считает выдачи). Счётчик
 *   транспорта, а не число попыток теста: к прохождению он отношения не имеет, имя колонки —
 *   дословно из DDL документа.
 *
 * Колонки `attempts_count` из `docs/v2/37` §3.1 здесь нет: она заведена под именем
 * `attempt_no` — как в `workshop_submissions`, где тот же смысл («какая по счёту сдача»).
 *
 * - `vacancy_publications.attempts` — сколько раз адаптер площадки уже пробовал опубликовать
 *   объявление (`29` §7.16: ретраи 1/5/25 мин на временную ошибку). Счётчик обращений к
 *   внешнему сервису, а не разрешённое число попыток прохождения — кандидат об этой колонке
 *   не знает и на его назначение она не ссылается.
 *
 * Список закрытый: правило прохождения, попавшее в таблицу пакета, по-прежнему красит тест.
 */
const PACKAGE_COLUMN_EXCEPTIONS = new Set([
  'review_queue_items.sla_due_at',
  'content_issues.due_at',
  'content_issues.rescored_attempts',
  'review_delegations.due_at',
  'review_sla_events.due_at',
  'storage_pending_uploads.attempts',
  'vacancy_publications.attempts',
])

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
