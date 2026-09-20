import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ENUMS } from '../../shared/enums'

/**
 * Паритет схемы с docs/02-data-model.md «Что проверяет тест схемы» (CLAUDE.md пп. 11, 13, 14):
 *
 * 1. У каждой таблицы с tenant_id есть политика RLS и индекс, начинающийся с tenant_id.
 * 2. Ни одна таблица контента не содержит колонок attempts / pass_score / due_at / time_limit —
 *    правила прохождения живут в assignments.params (docs/15 §14.3).
 * 3. Перечисления из docs/02 объявлены в shared/enums.ts ровно в том составе, что в документе,
 *    а ограничения в БД (CHECK) совпадают с ними.
 * 5. У каждой таблицы-журнала есть колонка request_context jsonb.
 *    (п. 4 — enrollment_status в отчётных представлениях — проверяется тестами отчётов.)
 */

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

/** Таблицы контента (docs/08 §12.8): карточка содержит только материал. */
const CONTENT_TABLES = [
  'courses', 'course_versions', 'modules', 'lessons', 'resources', 'resource_versions', 'quizzes', 'questions', 'question_banks',
  'complex_tests', 'workshops', 'meetups', 'webinars', 'programs', 'program_nodes', 'trajectories', 'trajectory_nodes', 'knowledge_articles', 'news', 'surveys',
  'notices', 'simple_notices', // Spec 21: объявление — контент, срок подтверждения — в назначении
]
/**
 * Исключения, заданные самим ТЗ:
 * - lessons.pass_score_pct — порог теста в плане курса (docs/02 §2.4 course_items.pass_score_pct, docs/11 §14.1);
 * - questions.time_limit_sec — свойство вопроса (docs/12 §3.2), включается параметром назначения question_time_limit.
 * Анкеты (checklists, assessment_forms) в список контента не входят: docs/08 §12.8 — их параметры неотделимы от состава.
 * Долг news.ack_due_at закрыт в Spec 21: срок подтверждения объявления — assignments.due_at.
 */
const CONTENT_COLUMN_EXCEPTIONS = new Set(['lessons.pass_score_pct', 'questions.time_limit_sec'])
const FORBIDDEN = /attempts|pass_score|due_at|time_limit/

/** Журналы (docs/22 §13.4): технический контекст пишется одинаково во все. */
const LOG_TABLES = ['audit_log', 'security_log', 'sessions', 'enrollment_events', 'notifications', 'import_jobs', 'goal_status_log', 'automation_runs', 'task_access_log', 'org_conflicts']

let tenantTables: string[] = []
let columns: { table: string, column: string, type: string }[] = []

beforeAll(async () => {
  const rows = await admin`
    select c.relname as table_name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname`
  tenantTables = rows.map(r => r.table_name as string)
  const cols = await admin`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'`
  columns = cols.map(c => ({ table: c.table_name as string, column: c.column_name as string, type: c.data_type as string }))
})

afterAll(async () => {
  await admin.end()
})

describe('1. RLS и индекс по tenant_id', () => {
  it('у каждой таблицы с tenant_id есть политика', async () => {
    const pol = await admin`select tablename from pg_policies where schemaname = 'public'`
    const has = new Set(pol.map(p => p.tablename as string))
    const missing = tenantTables.filter(t => !has.has(t))
    expect(missing, `без политики: ${missing.join(', ')}`).toEqual([])
  })

  it('у каждой таблицы с tenant_id есть индекс, начинающийся с tenant_id', async () => {
    // Первая колонка индекса — tenant_id (docs/25 §15). Уникальные ограничения тоже считаются.
    const idx = await admin`
      select t.relname as table_name
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where n.nspname = 'public' and a.attname = 'tenant_id'`
    const has = new Set(idx.map(r => r.table_name as string))
    const missing = tenantTables.filter(t => !has.has(t))
    expect(missing, `без индекса по tenant_id: ${missing.join(', ')}`).toEqual([])
  })
})

describe('2. Правила прохождения не в контенте', () => {
  it('таблицы контента существуют', () => {
    const existing = new Set(columns.map(c => c.table))
    const gone = CONTENT_TABLES.filter(t => !existing.has(t))
    expect(gone, `нет таблиц: ${gone.join(', ')}`).toEqual([])
  })

  it('в таблицах контента нет attempts / pass_score / due_at / time_limit', () => {
    const bad = columns
      .filter(c => CONTENT_TABLES.includes(c.table) && FORBIDDEN.test(c.column))
      .map(c => `${c.table}.${c.column}`)
      .filter(k => !CONTENT_COLUMN_EXCEPTIONS.has(k))
    expect(bad, `правила прохождения в контенте: ${bad.join(', ')}`).toEqual([])
  })

  it('правила живут в assignments.params, копия — в attempts.params', () => {
    const has = (t: string, c: string) => columns.some(x => x.table === t && x.column === c && x.type === 'jsonb')
    expect(has('assignments', 'params')).toBe(true)
    expect(has('attempts', 'params')).toBe(true)
    expect(has('complex_test_attempts', 'params')).toBe(true)
  })
})

describe('3. Перечисления из docs/02', () => {
  const doc = readFileSync(resolve(__dirname, '../../docs/02-data-model.md'), 'utf8')
  const section = doc.split('## Перечисления, снятые с эталона')[1]?.split('## ')[0] ?? ''
  const fromDoc: Record<string, string[]> = {}
  for (const m of section.matchAll(/^(\w+):\s*([^\n]+(?:\n\s+\|[^\n]+)*)/gm)) {
    fromDoc[m[1]!] = m[2]!.split('|').map(s => s.trim()).filter(Boolean)
  }

  it('документ содержит блок перечислений', () => {
    expect(Object.keys(fromDoc).length).toBeGreaterThanOrEqual(7)
  })

  it('shared/enums.ts совпадает с документом ровно', () => {
    for (const [name, values] of Object.entries(fromDoc)) {
      expect(ENUMS[name], `перечисление ${name} не объявлено в shared/enums.ts`).toBeDefined()
      expect([...ENUMS[name]!], `состав ${name}`).toEqual(values)
    }
    for (const name of Object.keys(ENUMS)) expect(fromDoc[name], `лишнее перечисление ${name}`).toBeDefined()
  })

  it('ограничения в БД совпадают с перечислениями', async () => {
    const checks = await admin`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where contype = 'c' and conname in ('assignments_subject_type_content_type', 'assignments_kind_task_type', 'enrollments_status_enrollment_status', 'program_enrollments_status_enrollment_status', 'security_log_severity_security_severity', 'trajectory_enrollments_status_enrollment_status', 'trajectory_nodes_kind_trajectory_node_kind', 'trajectories_assign_mode_assign_mode')`
    const defOf = (n: string) => checks.find(c => c.conname === n)?.def as string | undefined
    const valuesIn = (def: string) => [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]!)
    expect(defOf('assignments_subject_type_content_type')).toBeDefined()
    expect(valuesIn(defOf('assignments_subject_type_content_type')!)).toEqual([...ENUMS.content_type!])
    expect(defOf('assignments_kind_task_type')).toBeDefined()
    expect(valuesIn(defOf('assignments_kind_task_type')!)).toEqual([...ENUMS.task_type!])
    // Пять статусов прохождения (CLAUDE.md п. 12) — и у записей на курс, и у записей на программу
    for (const c of ['enrollments_status_enrollment_status', 'program_enrollments_status_enrollment_status', 'trajectory_enrollments_status_enrollment_status']) {
      expect(defOf(c), c).toBeDefined()
      expect(valuesIn(defOf(c)!)).toEqual([...ENUMS.enrollment_status!])
    }
    // Узлы траектории и режим назначения (spec-17) — trajectory_node_kind, assign_mode
    expect(valuesIn(defOf('trajectory_nodes_kind_trajectory_node_kind')!)).toEqual([...ENUMS.trajectory_node_kind!])
    expect(valuesIn(defOf('trajectories_assign_mode_assign_mode')!)).toEqual([...ENUMS.assign_mode!])
    // Уровень события журнала безопасности — security_severity (docs/02), колонка security_log.severity
    expect(defOf('security_log_severity_security_severity')).toBeDefined()
    expect(valuesIn(defOf('security_log_severity_security_severity')!)).toEqual([...ENUMS.security_severity!])
  })
})

describe('5. Технический контекст в журналах', () => {
  it('у каждой таблицы-журнала есть request_context jsonb', () => {
    const missing = LOG_TABLES.filter(t => !columns.some(c => c.table === t && c.column === 'request_context' && c.type === 'jsonb'))
    expect(missing, `нет request_context: ${missing.join(', ')}`).toEqual([])
  })
})
