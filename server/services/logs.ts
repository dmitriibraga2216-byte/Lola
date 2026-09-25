import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { keysetAfter, keysetAt } from '../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import type { LogFilter } from '../../shared/schemas/reports'
import { frameFirst, frameJoins, frameSelect, frameTail, periodSql } from './reportFrame'
import { IS_EMPLOYEE } from './repo/people'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>

/**
 * Контекст с явным правом видеть кандидатов (docs/28 §28.9.1 п.1, решение владельца 25.09) —
 * только для функций, что показывают человека в строке журнала (`readLog`, `readLogPage`,
 * `logRows`); `sessionsDailyAvg` и `retentionScan` людей не показывают и этого поля не требуют.
 * Поле обязательное, без значения по умолчанию: право называется явно на каждом вызове — тот
 * же принцип, что у `frameKind()` («умолчания нет намеренно»).
 */
type PersonLogCtx = Ctx & { canSeeCandidates: boolean }

/**
 * Журналы (docs/22 §5, §13.4): единый вход `/logs/:kind` с фильтрами по периоду, человеку, типу события;
 * сроки хранения (Г-22.2) и ежедневная очистка `logs.retention`. Записи неизменяемы — только чтение и удаление по сроку.
 * Человек в каждом журнале — единый каркас (`reportFrame`): ПІБ · посада · місто · підрозділ · мітки;
 * технический контекст — одинаковые колонки `ip`, `geo`, `client` (CLAUDE.md п. 14).
 * Кандидат в строке виден только смотрящему с `candidate.view` (docs/28 §28.9.1 п.1) — кроме
 * `security`, он остаётся полным по `audit.view` (решение владельца 25.09; см. `kindGate` ниже).
 */
export const LOG_KINDS = ['task-status', 'task-access', 'org-conflicts', 'notifications', 'sessions', 'security', 'import', 'automation', 'integrations'] as const
export type LogKind = typeof LOG_KINDS[number]

/** Сроки хранения, дней (docs/22 Г-22.2); null — бессрочно (смена статусов заданий — это и есть история обучения). */
export const RETENTION_DAYS: Record<LogKind, number | null> = {
  'task-status': null, 'task-access': 365, 'org-conflicts': 2 * 365, 'notifications': 365, 'sessions': 365, 'security': 3 * 365, 'import': 3 * 365, 'automation': 365, 'integrations': 90,
}
const AUDIT_RETENTION_DAYS = 3 * 365

export type { LogFilter }

/** Только строки страницы, без курсора следующей — для выгрузки, отчётов и мест, где страница одна. */
export async function readLog(ctx: PersonLogCtx, kind: LogKind, f: LogFilter = {} as LogFilter): Promise<Row[]> {
  return (await readLogPage(ctx, kind, f)).rows
}

/**
 * Страница журнала и курсор следующей (`null` — дальше нет).
 *
 * Сортировка — `created_at desc, id desc`, курсор — эта пара у последней строки, момент текстом из
 * Postgres с микросекундами (`shared/domain/keyset.ts`). Прежний курсор был голым моментом,
 * который клиент брал из последней строки: второго ключа не было, и строки того же момента
 * терялись на границе страниц — а пачка уведомлений или событий одной транзакции получает
 * один `created_at` на всех. Id сравнивается текстом: у журнала безопасности он `bigint`,
 * у протокола статусов строки идут из трёх таблиц; порядок текста годится, пока он один и тот
 * же в `order by` и в условии курсора.
 */
export async function readLogPage(ctx: PersonLogCtx, kind: LogKind, f: LogFilter = {} as LogFilter): Promise<{ rows: Row[], cursor: string | null }> {
  const limit = Math.min(500, f.limit ?? 100)
  const period = (col: SQL) => periodSql(col, f)
  const cursor = (at: SQL, id: SQL) => {
    const after = keysetAfter(KEYSETS.logs, f.cursor, [at, sql`${id}::text`], 'desc')
    return after ? sql`and ${after}` : sql``
  }
  const cursorAt = (at: SQL) => sql`${keysetAt(at)} as cursor_at`
  // Технический контекст (CLAUDE.md п. 14, docs/22 §13.4): IP с геолокацией и браузер — одинаково во всех журналах
  const context = (col: SQL, ip: SQL | null) => sql`${ip ? sql`coalesce(${col}->>'ip', host(${ip}))` : sql`${col}->>'ip'`} as ip, ${col}->'geo' as geo, nullif(concat_ws(', ', ${col}->>'browser', ${col}->>'os'), '') as client`
  // Человек в журнале — каркас без хвоста: там, где нет «прохождения», даты/статус/результат не нужны
  const person = frameSelect()
  const joins = frameJoins()
  const byUser = (col: SQL) => f.userId ? sql`and ${col} = ${f.userId}::uuid` : sql``
  /**
   * Вид человека в строке — по праву смотрящего (docs/28 §28.9.1 п.1, решение владельца 25.09):
   * без `candidate.view` строка про кандидата скрыта — остаются только сотрудники и строки без
   * человека (`u.id is null`: место занято внешним join'ом в `org-conflicts`/`automation`,
   * человек в строке — не обязателен); с правом ограничения нет. `IS_EMPLOYEE()` — тот же
   * предикат репозитория людей, что у `frameKind()`/`frameWhere()` (В-8), здесь обёрнут
   * null-проверкой ради nullable join'ов. Журнал `security` этот predicate не получает вовсе —
   * решение владельца оставляет его полным для `audit.view`: вход кандидата там нужен для
   * расследований.
   */
  const kindGate = ctx.canSeeCandidates ? sql`` : sql`and (u.id is null or ${IS_EMPLOYEE('u')})`
  // «Підрозділ» (мокап SecurityLog): подразделение основного размещения с потомками по ltree
  const byUnit = f.orgUnitId ? sql`and coalesce(pl.org_unit_id, l.org_unit_id) in (select id from org_units where path <@ (select path from org_units where id = ${f.orgUnitId}::uuid))` : sql``
  const rows = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    switch (kind) {
      case 'task-status':
        // Протокол змін статусу завдань (docs/22 §13.4): записи курса — из enrollment_events, тесты — из attempt_results,
        // программы и траектории — из pass_events (docs/33 D-045; content_type строки — training_program | trajectory).
        // Статус на момент события — payload.to (Spec 22), для старых записей — по коду события.
        return tx.execute(sql`
          select x.*, ${cursorAt(sql`x.created_at`)} from (
            select ev.id::text as id, ev.created_at, ${person},
                   ${frameTail({ assignedAt: sql`e.created_at`, completedAt: sql`e.completed_at`, status: sql`case when ev.payload->>'to' in ('not_assigned', 'not_started', 'in_progress', 'done', 'failed') then ev.payload->>'to' else case ev.event when 'created' then 'not_started' when 'started' then 'in_progress' when 'progress' then 'in_progress' when 'completed' then 'done' when 'failed' then 'failed' when 'expired' then 'failed' when 'reset' then 'not_started' else e.status end end`, result: sql`coalesce((ev.payload->>'result')::int, round(coalesce(e.score, e.progress_pct))::int)` })},
                   coalesce(a.title, c.title) as task_title, 'course' as content_type, ev.event, ev.payload, case when ev.payload->>'from' in ('not_assigned', 'not_started', 'in_progress', 'done', 'failed') then ev.payload->>'from' end as from_status, ev.actor_id, ${context(sql`ev.request_context`, null)}
            from enrollment_events ev join enrollments e on e.id = ev.enrollment_id join users u on u.id = e.user_id ${joins}
            left join courses c on c.id = e.subject_id left join assignments a on a.id = e.assignment_id
            where ev.event <> 'progress' ${period(sql`ev.created_at`)} ${cursor(sql`ev.created_at`, sql`ev.id`)} ${byUser(sql`e.user_id`)} ${kindGate} ${f.type ? sql`and ev.event = ${f.type}` : sql``}
              ${f.contentType && f.contentType !== 'course' ? sql`and false` : sql``} ${f.contentId ? sql`and e.subject_id = ${f.contentId}::uuid` : sql``}
            union all
            select ar.id::text, ar.created_at, ${person},
                   ${frameTail({ assignedAt: sql`at.created_at`, completedAt: sql`case when ar.passed then ar.created_at end`, status: sql`case ar.status when 'passed' then 'done' when 'failed' then 'failed' when 'expired' then 'failed' else 'in_progress' end`, result: sql`round(ar.score)::int` })},
                   coalesce(a.title, qz.title), 'test', 'attempt.' || ar.reason, jsonb_build_object('attemptNo', at.attempt_no, 'attemptsAllowed', a.params->>'attemptsAllowed', 'comment', ar.comment), null, ar.created_by, ${context(sql`null::jsonb`, null)}
            from attempt_results ar join attempts at on at.id = ar.attempt_id join users u on u.id = at.user_id ${joins}
            left join quizzes qz on qz.id = at.quiz_id left join assignments a on a.id = at.assignment_id
            where true ${period(sql`ar.created_at`)} ${cursor(sql`ar.created_at`, sql`ar.id`)} ${byUser(sql`at.user_id`)} ${kindGate} ${f.type ? sql`and 'attempt.' || ar.reason = ${f.type}` : sql``}
              ${f.contentType && f.contentType !== 'test' ? sql`and false` : sql``} ${f.contentId ? sql`and at.quiz_id = ${f.contentId}::uuid` : sql``}
            union all
            select pe.id::text, pe.created_at, ${person},
                   ${frameTail({ assignedAt: sql`coalesce(pr.created_at, tr.created_at)`, completedAt: sql`coalesce(pr.completed_at, tr.completed_at)`, status: sql`case when pe.payload->>'to' in ('not_assigned', 'not_started', 'in_progress', 'done', 'failed') then pe.payload->>'to' else case pe.event when 'created' then 'not_started' when 'started' then 'in_progress' when 'completed' then 'done' when 'failed' then 'failed' when 'reset' then 'not_started' else coalesce(pr.status, tr.status) end end`, result: sql`coalesce((pe.payload->>'result')::int, round(coalesce(pr.progress_pct, tr.progress_pct))::int)` })},
                   coalesce(a.title, prg.title, trj.title), pe.subject_type, pe.event, pe.payload, case when pe.payload->>'from' in ('not_assigned', 'not_started', 'in_progress', 'done', 'failed') then pe.payload->>'from' end, pe.actor_id, ${context(sql`pe.request_context`, null)}
            from pass_events pe join users u on u.id = pe.user_id ${joins}
            left join program_enrollments pr on pr.id = pe.enrollment_id and pe.subject_type = 'training_program'
            left join trajectory_enrollments tr on tr.id = pe.enrollment_id and pe.subject_type = 'trajectory'
            left join programs prg on prg.id = pe.subject_id and pe.subject_type = 'training_program'
            left join trajectories trj on trj.id = pe.subject_id and pe.subject_type = 'trajectory'
            left join assignments a on a.id = pr.assignment_id
            where true ${period(sql`pe.created_at`)} ${cursor(sql`pe.created_at`, sql`pe.id`)} ${byUser(sql`pe.user_id`)} ${kindGate} ${f.type ? sql`and pe.event = ${f.type}` : sql``}
              ${f.contentType ? (f.contentType === 'training_program' ? sql`and pe.subject_type = 'training_program'` : sql`and false`) : sql``} ${f.contentId ? sql`and pe.subject_id = ${f.contentId}::uuid` : sql``}
          ) x order by x.created_at desc, x.id desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'task-access':
        // Звіт звернень до завдань: каждое открытие — строка; IP и браузер — из request_context
        return tx.execute(sql`
          select t.id, t.created_at, ${cursorAt(sql`t.created_at`)}, ${person}, t.content_type, t.content_id, t.title as task_title, t.action, t.assignment_id, ${context(sql`t.request_context`, null)}
          from task_access_log t join users u on u.id = t.user_id ${joins}
          where true ${period(sql`t.created_at`)} ${cursor(sql`t.created_at`, sql`t.id`)} ${byUser(sql`t.user_id`)} ${kindGate}
            ${f.type ? sql`and t.action = ${f.type}` : sql``} ${f.contentType ? sql`and t.content_type = ${f.contentType}` : sql``} ${f.contentId ? sql`and t.content_id = ${f.contentId}::uuid` : sql``}
          order by t.created_at desc, t.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'org-conflicts':
        return tx.execute(sql`
          select o.id, o.created_at, ${cursorAt(sql`o.created_at`)}, ${person}, o.kind, o.source, o.details, o.import_job_id, o.resolved_at, act.full_name as actor, ${context(sql`o.request_context`, null)}
          from org_conflicts o left join users u on u.id = o.user_id ${joins} left join users act on act.id = o.actor_id
          where true ${period(sql`o.created_at`)} ${cursor(sql`o.created_at`, sql`o.id`)} ${byUser(sql`o.user_id`)} ${byUnit} ${kindGate} ${f.type ? sql`and o.kind = ${f.type}` : sql``}
            ${f.state === 'open' ? sql`and o.resolved_at is null` : f.state === 'resolved' ? sql`and o.resolved_at is not null` : sql``}
          order by o.created_at desc, o.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'notifications':
        return tx.execute(sql`
          select n.id, n.created_at, ${cursorAt(sql`n.created_at`)}, n.code, n.channel, n.status, n.error, n.rendered_text, n.sent_at, n.scheduled_for, ${person}, ${context(sql`n.request_context`, null)}
          from notifications n join users u on u.id = n.user_id ${joins}
          where true ${period(sql`n.created_at`)} ${cursor(sql`n.created_at`, sql`n.id`)} ${byUser(sql`n.user_id`)} ${kindGate} ${f.type ? sql`and n.code = ${f.type}` : sql``}
          order by n.created_at desc, n.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'sessions':
        return tx.execute(sql`
          select s.id, s.created_at, ${cursorAt(sql`s.created_at`)}, coalesce(s.revoked_at, s.updated_at) as ended_at, (s.revoked_at is null and s.expires_at > now()) as active, s.impersonated_by, ${person}, ${context(sql`s.request_context`, sql`s.ip`)}
          from sessions s join users u on u.id = s.user_id ${joins}
          where true ${period(sql`s.created_at`)} ${cursor(sql`s.created_at`, sql`s.id`)} ${byUser(sql`s.user_id`)} ${kindGate}
          order by s.created_at desc, s.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'security':
        // Решение владельца 25.09 (docs/28 §28.9.1 п.1): журнал безопасности не получает kindGate —
        // вход кандидата в нём виден целиком тому, у кого есть право на сам журнал (`audit.view`,
        // проверяется на входе в ручку); это нужно для расследований и не сужается `candidate.view`.
        return tx.execute(sql`
          select s.id, s.created_at, ${cursorAt(sql`s.created_at`)}, s.severity, s.event, s.meta, ${person}, ${context(sql`s.request_context`, sql`s.ip`)}
          from security_log s left join users u on u.id = s.user_id ${joins}
          where true ${period(sql`s.created_at`)} ${cursor(sql`s.created_at`, sql`s.id`)} ${byUser(sql`s.user_id`)} ${byUnit} ${f.type ? sql`and s.event like ${`${f.type}%`}` : sql``} ${f.severity ? sql`and s.severity = ${f.severity}` : sql``}
          order by s.created_at desc, s.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'import':
        return tx.execute(sql`
          select j.id, j.created_at, ${cursorAt(sql`j.created_at`)}, j.file_name, j.source, j.status, j.stats, j.finished_at, u.full_name as created_by_name, ${context(sql`j.request_context`, null)}
          from import_jobs j left join users u on u.id = j.created_by
          where true ${period(sql`j.created_at`)} ${cursor(sql`j.created_at`, sql`j.id`)} ${byUser(sql`j.created_by`)}
          order by j.created_at desc, j.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'automation':
        return tx.execute(sql`
          select r.id, r.created_at, ${cursorAt(sql`r.created_at`)}, r.status, r.error, r.actions_result, r.trigger_payload, ar.name as rule, ${person}, ${context(sql`r.request_context`, null)}
          from automation_runs r join automation_rules ar on ar.id = r.rule_id left join users u on u.id = r.user_id ${joins}
          where true ${period(sql`r.created_at`)} ${cursor(sql`r.created_at`, sql`r.id`)} ${byUser(sql`r.user_id`)} ${kindGate} ${f.type ? sql`and r.status = ${f.type}` : sql``}
          order by r.created_at desc, r.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
      case 'integrations':
        return tx.execute(sql`
          select d.id, d.created_at, ${cursorAt(sql`d.created_at`)}, d.event, d.status, d.status_code, d.attempt, d.payload, d.response_body, d.delivered_at, w.url
          from webhook_deliveries d left join webhook_endpoints w on w.id = d.endpoint_id
          where true ${period(sql`d.created_at`)} ${cursor(sql`d.created_at`, sql`d.id`)} ${f.type ? sql`and d.event = ${f.type}` : sql``}
          order by d.created_at desc, d.id::text desc limit ${limit + 1}`) as unknown as Promise<Row[]>
    }
  })
  const page = rows.slice(0, limit)
  const last = rows.length > limit ? page[page.length - 1] : undefined
  return {
    // Момент для курсора — служебная колонка: ни в таблицу журнала, ни в выгрузку она не идёт.
    rows: page.map(({ cursor_at: _cursorAt, ...r }) => r),
    cursor: last ? encodeKeyset(KEYSETS.logs, [String(last.cursor_at), String(last.id)]) : null,
  }
}

/**
 * Графік «Середній час у системі» (docs/28 «Spec 22» отк. (4), D-003): середня тривалість
 * сесії за добу за останні `days` днів — проста серверна агрегація для SVG-смуги без бібліотек
 * (`SessionsLog.vue`). Дні без сесій потрапляють у ряд нулями (`generate_series`).
 */
export async function sessionsDailyAvg(ctx: Ctx, days = 30): Promise<{ day: string, avgMinutes: number, sessions: number }[]> {
  const n = Math.min(90, Math.max(1, days))
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select to_char(d.day, 'YYYY-MM-DD') as day,
             coalesce(round(avg(extract(epoch from (coalesce(s.revoked_at, s.updated_at, now()) - s.created_at)) / 60)::numeric, 1), 0) as avg_minutes,
             count(s.id)::int as sessions
      from generate_series((current_date - (${n}::int - 1)), current_date, interval '1 day') d(day)
      left join sessions s on s.created_at::date = d.day
      group by d.day
      order by d.day
    `) as unknown as { day: string, avg_minutes: string, sessions: number }[]
    return rows.map(r => ({ day: r.day, avgMinutes: Number(r.avg_minutes), sessions: r.sessions }))
  })
}

/** Строки журнала для выгрузки: колонки каркаса первыми, объекты — строкой. */
export async function logRows(ctx: PersonLogCtx, kind: LogKind, f: LogFilter): Promise<Row[]> {
  const rows = await readLog(ctx, kind, { ...f, limit: 500 })
  return frameFirst(rows.map(r => ({ ...r, geo: r.geo && typeof r.geo === 'object' ? [(r.geo as Row).country, (r.geo as Row).city].filter(Boolean).join(', ') : r.geo })))
}

/** Ежедневно `logs.retention`: удаление записей старше срока хранения. Бессрочные журналы не трогаются. */
export async function retentionScan(tenantId: string): Promise<Record<string, number>> {
  return withTenant(tenantId, null, async (tx) => {
    const out: Record<string, number> = {}
    const del = async (name: string, query: SQL) => { const rows = await tx.execute(query) as unknown as unknown[]; out[name] = rows.length }
    await del('audit', sql`delete from audit_log where created_at < now() - (${AUDIT_RETENTION_DAYS} || ' days')::interval returning id`)
    await del('task-access', sql`delete from task_access_log where created_at < now() - (${RETENTION_DAYS['task-access']} || ' days')::interval returning id`)
    await del('org-conflicts', sql`delete from org_conflicts where created_at < now() - (${RETENTION_DAYS['org-conflicts']} || ' days')::interval returning id`)
    await del('notifications', sql`delete from notifications where created_at < now() - (${RETENTION_DAYS.notifications} || ' days')::interval returning id`)
    await del('sessions', sql`delete from sessions where created_at < now() - (${RETENTION_DAYS.sessions} || ' days')::interval returning id`)
    await del('security', sql`delete from security_log where created_at < now() - (${RETENTION_DAYS.security} || ' days')::interval returning id`)
    await del('import', sql`delete from import_jobs where created_at < now() - (${RETENTION_DAYS.import} || ' days')::interval returning id`)
    await del('automation', sql`delete from automation_runs where created_at < now() - (${RETENTION_DAYS.automation} || ' days')::interval returning id`)
    await del('integrations', sql`delete from webhook_deliveries where created_at < now() - (${RETENTION_DAYS.integrations} || ' days')::interval returning id`)
    await del('search', sql`delete from search_queries where created_at < now() - interval '365 days' returning id`)
    // Одноразовые токены бота (привязка чата, кнопка входа — строка на каждое сообщение с кнопкой):
    // после срока они ничего не открывают, хранить их незачем
    await del('telegram-tokens', sql`delete from telegram_tokens where expires_at < now() - interval '1 day' returning id`)
    return out
  })
}
