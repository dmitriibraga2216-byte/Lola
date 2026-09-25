import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Девятый контрактный тест пакета `docs/v2` — решение `44-decisions.md` В-13.
 *
 * Цикл «кандидаты ↔ вакансии» настоящий: `users.vacancy_id → vacancies.id`, а
 * `vacancies.recruiter_id → users.id`. Порядка создания таблиц, снимающего его, не
 * существует, поэтому колонка заводится без ключа, а ключ добавляется **миграцией-развязкой**.
 * Формулировка «добавим отдельной миграцией потом» в половине случаев означает «не добавили»,
 * и этот тест превращает обещание в гейт.
 *
 * **Проверка по имени, а не по факту наличия FK на колонке** — намеренно (В-13): иначе тест
 * зазеленел бы от любого ключа, включая ошибочный. Имена и `on delete` зафиксированы в В-13
 * заранее, до того как их написали в миграции.
 *
 * > [исправлено, PR-40: все четыре развязки в `main` — `0064_v2_candidates` (статус кандидата),
 * > `0072_v2_users_vacancy_fk` (вакансия), `0080_v2_review_delegation` (оба ключа очереди)]
 * > Ранее: «два ключа очереди проверки ждут своих таблиц (PR-19) … тест печатает их как ожидающие
 * > и начинает требовать в тот момент, когда таблица появляется».
 * Ветка «целевой таблицы ещё нет — ключа быть не может» снята: после PR-19 она превратила бы
 * пропавшую таблицу в зелёный тест. Теперь все четыре ключа обязательны, и каждый проверяется
 * целиком — по имени, **на своей таблице и своей колонке**, со своей целью и `on delete set null`.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

afterAll(async () => { await admin.end() })

/** Таблица В-13: имя констрейнта → таблица и колонка, цель, `on delete`. Ровно четыре. */
const DEFERRED_FK = [
  { name: 'users_candidate_status_id_fk', table: 'users', column: 'candidate_status_id', target: 'candidate_statuses', onDelete: 'SET NULL' },
  { name: 'users_vacancy_id_fk', table: 'users', column: 'vacancy_id', target: 'vacancies', onDelete: 'SET NULL' },
  { name: 'rqi_delegation_id_fk', table: 'review_queue_items', column: 'delegation_id', target: 'review_delegations', onDelete: 'SET NULL' },
  { name: 'rqi_assigned_by_rule_id_fk', table: 'review_queue_items', column: 'assigned_by_rule_id', target: 'review_routing_rules', onDelete: 'SET NULL' },
] as const

const constraints = await admin`
  select c.conname as name,
         c.conrelid::regclass::text as table_name,
         c.confrelid::regclass::text as target,
         (select array_agg(a.attname::text order by a.attnum)
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as columns,
         pg_get_constraintdef(c.oid) as def
    from pg_constraint c
   where c.contype = 'f'
     and c.connamespace = 'public'::regnamespace`

describe('9. Отложенные внешние ключи циклов (docs/v2/44 В-13)', () => {
  it('в таблице В-13 ровно четыре ключа, имена не повторяются', () => {
    expect(DEFERRED_FK).toHaveLength(4)
    expect(new Set(DEFERRED_FK.map(f => f.name)).size).toBe(4)
  })

  for (const fk of DEFERRED_FK) {
    it(`${fk.name}: ${fk.table}.${fk.column} → ${fk.target}(id) on delete ${fk.onDelete.toLowerCase()}`, async () => {
      const [target] = await admin`select to_regclass(${`public.${fk.target}`}) as reg`
      expect(target!.reg, `целевой таблицы ${fk.target} нет — развязка В-13 потеряла цель`).not.toBeNull()

      const found = constraints.find(c => c.name === fk.name)
      expect(found, `констрейнт ${fk.name} отсутствует: колонка есть, ссылочной целостности нет`).toBeDefined()
      expect(found!.table_name, `${fk.name} стоит не на той таблице`).toBe(fk.table)
      expect(found!.columns, `${fk.name} стоит не на той колонке`).toEqual([fk.column])
      expect(found!.target, `${fk.name} ссылается не туда`).toBe(fk.target)
      expect(found!.def as string).toContain(`REFERENCES ${fk.target}(id)`)
      // Ни одного cascade (В-13): удаление статуса не уносит кандидата, а удаление правила
      // маршрутизации — работу из очереди.
      expect(found!.def as string).toContain(`ON DELETE ${fk.onDelete}`)
      expect(found!.def as string).not.toContain('ON DELETE CASCADE')
    })
  }

  it('колонки развязок существуют, имеют тип uuid и допускают null (on delete set null)', async () => {
    const cols = await admin`
      select table_name, column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (('users', 'candidate_status_id'), ('users', 'vacancy_id'),
                                           ('review_queue_items', 'delegation_id'), ('review_queue_items', 'assigned_by_rule_id'))`
    const key = (t: string, c: string) => `${t}.${c}`
    const byKey = new Map(cols.map(c => [key(c.table_name as string, c.column_name as string), c]))
    for (const fk of DEFERRED_FK) {
      const col = byKey.get(key(fk.table, fk.column))
      expect(col, `колонки ${fk.table}.${fk.column} нет`).toBeDefined()
      expect(col!.data_type, `${fk.table}.${fk.column}`).toBe('uuid')
      expect(col!.is_nullable, `${fk.table}.${fk.column}: set null невозможен на not null`).toBe('YES')
    }
  })
})
