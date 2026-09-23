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
 * Два ключа очереди проверки (`rqi_delegation_id_fk`, `rqi_assigned_by_rule_id_fk`) ждут
 * своих таблиц (`review_delegations`, `review_routing_rules`, PR-19). Пока целевой таблицы
 * нет, требовать ключ бессмысленно — но и молчать нельзя: тест печатает их как ожидающие и
 * начинает требовать в тот момент, когда таблица появляется. Ни одной строки «проверим
 * потом» в этом файле нет.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

afterAll(async () => { await admin.end() })

/** Таблица В-13: имя констрейнта → колонка, цель, `on delete`. */
const DEFERRED_FK = [
  { name: 'users_candidate_status_id_fk', table: 'users', column: 'candidate_status_id', target: 'candidate_statuses', onDelete: 'SET NULL' },
  { name: 'users_vacancy_id_fk', table: 'users', column: 'vacancy_id', target: 'vacancies', onDelete: 'SET NULL' },
  { name: 'rqi_delegation_id_fk', table: 'review_queue_items', column: 'delegation_id', target: 'review_delegations', onDelete: 'SET NULL' },
  { name: 'rqi_assigned_by_rule_id_fk', table: 'review_queue_items', column: 'assigned_by_rule_id', target: 'review_routing_rules', onDelete: 'SET NULL' },
] as const

const constraints = await admin`
  select c.conname as name, pg_get_constraintdef(c.oid) as def
    from pg_constraint c where c.contype = 'f'`
const tables = (await admin`
  select table_name from information_schema.tables where table_schema = 'public'`).map(r => r.table_name as string)

describe('9. Отложенные внешние ключи циклов (docs/v2/44 В-13)', () => {
  for (const fk of DEFERRED_FK) {
    const ready = tables.includes(fk.target)
    it(`${fk.name} → ${fk.target}${ready ? '' : ' (целевая таблица ещё не создана)'}`, () => {
      if (!ready) {
        // Ключ не может существовать раньше таблицы, на которую смотрит. Фиксируем ровно это:
        // как только PR-19 создаст таблицу, ветка переключится и ключ станет обязательным.
        expect(constraints.some(c => c.name === fk.name), `${fk.name} не может существовать без ${fk.target}`).toBe(false)
        return
      }
      const found = constraints.find(c => c.name === fk.name)
      expect(found, `констрейнт ${fk.name} отсутствует: колонка есть, ссылочной целостности нет`).toBeDefined()
      expect(found!.def as string).toContain(`REFERENCES ${fk.target}(id)`)
      // Ни одного cascade (В-13): удаление статуса не уносит кандидата, а удаление правила
      // маршрутизации — работу из очереди.
      expect(found!.def as string).toContain(`ON DELETE ${fk.onDelete}`)
      expect(found!.def as string).not.toContain('ON DELETE CASCADE')
    })
  }

  it('колонка users.vacancy_id существует и не потеряла тип', async () => {
    const [col] = await admin`
      select data_type from information_schema.columns
       where table_name = 'users' and column_name = 'vacancy_id'`
    expect(col?.data_type).toBe('uuid')
  })
})
