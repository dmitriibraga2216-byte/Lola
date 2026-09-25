import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { V2_PACKAGE_PLATFORM_TABLES, V2_PACKAGE_TENANT_TABLES } from './v2-package-tables'

/**
 * Контрактный тест №6 пакета `docs/v2` — состав пакета, сводная проверка (`docs/v2/40-data-model-delta.md`
 * §8 тесты 6 и 8; план `docs/v2/45-plan.md` PR-40: «все тенантные таблицы пакета под RLS, список
 * проверяется на длину»).
 *
 * Тесты 1–3 и 5 перебирают `V2_PACKAGE_TENANT_TABLES` и потому молчат, если таблицу **забыли внести** в
 * список или **выбросили** из него. Этот тест закрывает оба направления:
 *  1. длина списка зафиксирована числом, а сам список обязан совпасть с составом `40` §6.1 за вычетом и
 *     плюс поимённых расхождений — каждое с PR и причиной (таблица «было в пакете → стало» —
 *     `docs/v2/40-data-model-delta.md` §2.13);
 *  2. каждая таблица, которую создаёт миграция пакета (`server/db/migrations/NNNN_v2_*.sql`), стоит в
 *     одном из двух списков — новая таблица пакета без контрактов не проходит;
 *  3. все тенантные — с `tenant_id not null`, RLS `enable`+`force` и политикой `tenant_isolation`
 *     (`using` и `with check`); все платформенные и `plans` — без `tenant_id` и вне RLS (`40` §8 тест 8);
 *  4. три таблицы `40` §2, которые решениями не заводятся, в базе действительно отсутствуют.
 */

/** Дословно `docs/v2/40-data-model-delta.md` §6.1 «Тенантные таблицы — 71» (в порядке документа). */
const DOC_40_TENANT = [
  'candidate_statuses', 'candidate_scores', 'candidate_comments', 'candidate_status_history', 'vacancies',
  'vacancy_languages', 'vacancy_criteria', 'vacancy_criterion_scores', 'vacancy_templates', 'job_board_accounts',
  'vacancy_publications', 'vacancy_applications', 'public_apply_attempts', 'vacancy_ai_generations', 'ai_providers',
  'ai_calls', 'interview_scenarios', 'interview_criteria', 'interview_consents', 'interview_sessions', 'interview_turns',
  'interview_criterion_scores', 'candidate_summaries', 'ai_review_hints', 'ai_quality_reviews', 'library_modules',
  'library_module_versions', 'library_module_usages', 'library_module_proposals', 'org_nodes', 'org_node_assignments',
  'org_manager_map', 'org_structure_snapshots', 'org_structure_conflicts', 'lifecycle_stages',
  'employee_lifecycle_state', 'offboarding_cases', 'storage_usage_counters', 'storage_usage_daily',
  'storage_retention_policies', 'storage_deletion_requests', 'storage_quota_addons', 'storage_pending_uploads',
  'tenant_addons', 'usage_counters', 'usage_events', 'tenant_payments', 'plan_change_requests', 'limit_notices',
  'content_issues', 'content_reports', 'content_issue_events', 'content_issue_routing_rules', 'content_reporter_stats',
  'review_delegations', 'review_routing_rules', 'reviewer_capacity', 'reviewer_absences', 'review_sla_events',
  'reviewer_stats_daily', 'content_time_norms', 'learning_time_sessions', 'learning_time_totals',
  'user_activity_events', 'user_activity_daily', 'person_notes', 'person_document_types', 'person_documents',
  'absence_norms', 'absence_records', 'person_rating_snapshots',
] as const

/** `docs/v2/40` §6.2 «Платформенные таблицы вне RLS — 2». */
const DOC_40_PLATFORM = ['plan_prices', 'plan_addons'] as const

/**
 * Три таблицы `40` §2, которых по факту нет (`40` §2.13). Не «забыли», а решили: функция живёт в другой
 * таблице, и заводить вторую значило бы держать два источника истины.
 */
const NOT_CREATED: Record<string, string> = {
  org_structure_conflicts: 'docs/v2/44 В-7, PR-30 #111: alter table org_conflicts (протокол конфликтов базового ТЗ с 0033)',
  person_notes: 'docs/v2/43 §1.2, PR-32 #121: та же сущность — существующая user_notes (с 0019), взята пакетом под своим именем',
  storage_quota_addons: 'docs/v2/40 Р-6, PR-08 #94 / PR-36 #122: докупка места — tenant_addons со storage_pack (сквозная проверка 23)',
}

/** Шесть тенантных таблиц сверх `40` §6.1 (`40` §2.13). */
const ADDED_TENANT: Record<string, string> = {
  review_queue_items: 'docs/v2/44 В-2, PR-18 #100: очередь — таблица с нуля вместо витрины (71-я таблица плана)',
  user_notes: 'docs/v2/43 §1.2, PR-32 #121: пакетная person_notes под своим именем; PR-32 дотянул её до контрактов 1–3',
  platform_announcement_reads: 'docs/v2/39 П-21, PR-39 #124: отметка прочтения объявления платформы',
  position_groups: 'docs/v2/39 П-24.5, PR-39 #124: группы должностей',
  user_totp: 'docs/v2/39 П-24.1, PR-39 #124: второй фактор входа',
  user_totp_recovery_codes: 'docs/v2/39 П-24.1, PR-39 #124: резервные коды второго фактора',
}

/** Одна платформенная сверх `40` §6.2 (`40` §2.13). */
const ADDED_PLATFORM: Record<string, string> = {
  platform_announcements: 'docs/v2/39 П-21, П-24.2, PR-39 #124: объявление оператора одно на платформу',
}

/**
 * Длина списков по факту — 71 − 3 + 6 = **74** тенантные и 2 + 1 = **3** платформенные. Числа зашиты
 * намеренно: изменение состава пакета обязано пройти через `docs/v2/40-data-model-delta.md` §2.13
 * (строка «было в пакете → стало → каким PR и почему») и через эти константы, а не молча через список.
 */
const EXPECTED_TENANT_TABLES = 74
const EXPECTED_PLATFORM_TABLES = 3

/** `user_notes` — единственная таблица списка, созданная не миграцией пакета (`0019`, базовое ТЗ). */
const TAKEN_OVER_BASE_TABLES = ['user_notes']

const MIGRATIONS_DIR = resolve(__dirname, '../../server/db/migrations')

/** Таблицы, которые создают миграции пакета: файлы `NNNN_v2_*.sql` (стиль имени — `docs/v2/45` §5). */
function tablesCreatedByPackageMigrations(): Map<string, string> {
  const created = new Map<string, string>()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(f => /^\d{4}_v2_.+\.sql$/.test(f)).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '')
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      created.set(m[1]!.toLowerCase(), file)
    }
  }
  return created
}

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('v2-contract-06: состав пакета — списки на длину и против 40 §6.1', () => {
  it(`тенантных таблиц пакета ровно ${EXPECTED_TENANT_TABLES}, платформенных — ${EXPECTED_PLATFORM_TABLES}, без повторов`, () => {
    expect(V2_PACKAGE_TENANT_TABLES, 'длина списка тенантных таблиц пакета (docs/v2/40 §2.13)').toHaveLength(EXPECTED_TENANT_TABLES)
    expect(new Set(V2_PACKAGE_TENANT_TABLES).size, 'повтор в списке тенантных таблиц').toBe(V2_PACKAGE_TENANT_TABLES.length)
    expect(V2_PACKAGE_PLATFORM_TABLES, 'длина списка платформенных таблиц пакета (docs/v2/40 §2.13)').toHaveLength(EXPECTED_PLATFORM_TABLES)
    expect(V2_PACKAGE_TENANT_TABLES.filter(t => V2_PACKAGE_PLATFORM_TABLES.includes(t)), 'таблица в обоих списках').toEqual([])
  })

  it('арифметика расхождений сходится: 71 − 3 + 6 = 74, 2 + 1 = 3', () => {
    expect(new Set(DOC_40_TENANT).size, 'docs/v2/40 §6.1 перечисляет 71 таблицу').toBe(71)
    for (const t of Object.keys(NOT_CREATED)) expect(DOC_40_TENANT as readonly string[], `${t} — из 40 §6.1`).toContain(t)
    for (const t of Object.keys(ADDED_TENANT)) expect(DOC_40_TENANT as readonly string[], `${t} — сверх 40 §6.1`).not.toContain(t)
    expect(DOC_40_TENANT.length - Object.keys(NOT_CREATED).length + Object.keys(ADDED_TENANT).length).toBe(EXPECTED_TENANT_TABLES)
    expect(DOC_40_PLATFORM.length + Object.keys(ADDED_PLATFORM).length).toBe(EXPECTED_PLATFORM_TABLES)
  })

  it('список тенантных таблиц = 40 §6.1 − не созданные + добавленные (поимённо)', () => {
    const expected = new Set<string>([...DOC_40_TENANT.filter(t => !(t in NOT_CREATED)), ...Object.keys(ADDED_TENANT)])
    const actual = new Set(V2_PACKAGE_TENANT_TABLES)
    expect(sorted([...expected].filter(t => !actual.has(t))), 'есть в составе пакета, нет в V2_PACKAGE_TENANT_TABLES').toEqual([])
    expect(sorted([...actual].filter(t => !expected.has(t))), 'есть в V2_PACKAGE_TENANT_TABLES без строки в 40 §2.13').toEqual([])
  })

  it('список платформенных таблиц = 40 §6.2 + добавленные', () => {
    expect(sorted(V2_PACKAGE_PLATFORM_TABLES)).toEqual(sorted([...DOC_40_PLATFORM, ...Object.keys(ADDED_PLATFORM)]))
  })

  it('каждая таблица, созданная миграцией пакета, стоит в одном из списков — и наоборот', () => {
    const created = tablesCreatedByPackageMigrations()
    const listed = new Set([...V2_PACKAGE_TENANT_TABLES, ...V2_PACKAGE_PLATFORM_TABLES])
    const unlisted = sorted([...created.keys()].filter(t => !listed.has(t))).map(t => `${t} (${created.get(t)})`)
    expect(unlisted, 'миграция пакета создаёт таблицу, которой нет в v2-package-tables.ts — контракты 1–5 её не видят').toEqual([])
    const notCreated = sorted([...listed].filter(t => !created.has(t) && !TAKEN_OVER_BASE_TABLES.includes(t)))
    expect(notCreated, 'таблица списка не создаётся ни одной миграцией пакета').toEqual([])
    for (const t of TAKEN_OVER_BASE_TABLES) expect(created.has(t), `${t} — таблица базового ТЗ, пакет её не создаёт`).toBe(false)
  })
})

describe('v2-contract-06: все тенантные таблицы пакета под RLS, платформенные — вне его', () => {
  it(`все ${EXPECTED_TENANT_TABLES} тенантных: tenant_id not null, RLS enable+force, tenant_isolation с using и with check`, async () => {
    const rows = await admin`
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             a.attnotnull as tenant_id_not_null,
             p.polqual is not null as has_using,
             p.polwithcheck is not null as has_with_check
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        left join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
        left join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
       where c.relkind = 'r' and c.relname in ${admin(V2_PACKAGE_TENANT_TABLES)}`
    const byName = new Map(rows.map(r => [r.table_name as string, r]))
    const broken: string[] = []
    for (const t of V2_PACKAGE_TENANT_TABLES) {
      const r = byName.get(t)
      if (!r) broken.push(`${t}: таблицы нет`)
      else if (!r.tenant_id_not_null || !r.rls_enabled || !r.rls_forced || !r.has_using || !r.has_with_check) {
        broken.push(`${t}: tenant_id not null=${r.tenant_id_not_null}, enable=${r.rls_enabled}, force=${r.rls_forced}, using=${r.has_using}, with check=${r.has_with_check}`)
      }
    }
    expect(broken, `тенантные таблицы пакета вне RLS: ${broken.join('; ')}`).toEqual([])
  })

  it('платформенные таблицы пакета и plans — без tenant_id и вне RLS (40 §8 тест 8)', async () => {
    const tables = [...V2_PACKAGE_PLATFORM_TABLES, 'plans']
    const rows = await admin`
      select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant_id
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relkind = 'r' and c.relname in ${admin(tables)}`
    expect(sorted(rows.map(r => r.table_name as string)), 'платформенной таблицы нет в базе').toEqual(sorted(tables))
    const broken = rows.filter(r => r.has_tenant_id || r.rls_enabled || r.rls_forced)
      .map(r => `${r.table_name}: tenant_id=${r.has_tenant_id}, enable=${r.rls_enabled}, force=${r.rls_forced}`)
    expect(broken, 'платформенная таблица с tenant_id или под RLS').toEqual([])
  })

  it('три таблицы 40 §2, которые решениями не заводятся, в базе отсутствуют', async () => {
    const [r] = await admin`
      select to_regclass('public.org_structure_conflicts') as org_structure_conflicts,
             to_regclass('public.person_notes') as person_notes,
             (select relkind from pg_class where oid = to_regclass('public.storage_quota_addons')) as storage_quota_addons_kind`
    expect(r!.org_structure_conflicts, NOT_CREATED.org_structure_conflicts).toBeNull()
    expect(r!.person_notes, NOT_CREATED.person_notes).toBeNull()
    // Сквозная проверка 23 (`42` §5): либо null, либо представление — но не таблица
    expect([null, 'v'], NOT_CREATED.storage_quota_addons).toContain(r!.storage_quota_addons_kind)
  })
})
