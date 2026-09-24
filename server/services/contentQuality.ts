import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { frameJoins, frameSelect, frameTail, frameWhere, periodSql } from './reportFrame'
import { authorIdsSql, uuidArray } from './contentIssueRouting'
import { CONFIRMING_RESOLUTIONS, OPEN_STATUSES, REJECTING_RESOLUTIONS, compareQuality, perHundred } from '../../shared/domain/contentIssues'
import type { ContentQualityQuery, ContentQualityReport, ContentQualityRow, IssueTrack } from '../../shared/schemas/contentIssues'

/**
 * Отчёт «Якість контенту» (docs/v2/36-content-feedback.md §9, критерий приёмки 9) — главный
 * отчёт модуля: строки — элементы контента (или треки), ключ сортировки — «Скарг на 100
 * проходжень». Нормировка обязательна: без неё в топ попадает самый популярный курс, а не
 * худший — 2 жалобы на 40 прохождений хуже, чем 15 на 3000.
 *
 * Отчёт стоит на едином каркасе (docs/22 §13.3, `reportFrame.ts`), хотя его строки — не люди:
 * числитель (кто пожаловался) и знаменатель (кто проходил) — это люди, и отбираются они одним
 * и тем же `frameJoins()`/`frameWhere()`, что и во всех отчётах репозитория. Отсюда три
 * свойства без собственного кода: вид людей — только сотрудники (П-16.1), область видимости
 * роли — по точкам (керівник видит свои точки, §2), архивированные исключены по умолчанию
 * (docs/22 §7.5). Детализация строки (docs/22 §3 п. 4) — список заявителей теми же колонками
 * каркаса: ПІБ · Посада · Місто · Підрозділ · Мітки · …
 */

export interface Viewer { tenantId: string, actorId: string, scope: string[] | null }

const CONFIRMED = sql.raw(CONFIRMING_RESOLUTIONS.map(r => `'${r}'`).join(', '))
const REJECTED = sql.raw(REJECTING_RESOLUTIONS.map(r => `'${r}'`).join(', '))
const OPEN = sql.raw(OPEN_STATUSES.map(s => `'${s}'`).join(', '))

/** Элемент строки: жалоба на блок относится к своему материалу — автор чинит материал. */
const ELEMENT_TYPE = sql`case when i.target_type = 'block' then 'resource' else i.target_type end`

interface Frame { scope: string[] | null, includeArchived?: boolean, locationId?: string }

/** Люди отчёта — единым каркасом: вид, область видимости, архив, точка. `u` — человек строки. */
function peopleWhere(f: Frame): SQL {
  return sql`${frameWhere({ scope: f.scope, includeArchived: f.includeArchived })}
    ${f.locationId ? sql`and pl.location_id = ${f.locationId}::uuid` : sql``}`
}

/** Фильтры карточки (`i`): тип проблемы, тип элемента, категория, автор. */
function issueWhere(q: ContentQualityQuery): SQL {
  return sql`
    ${q.issueType ? sql`and i.issue_type = ${q.issueType}` : sql``}
    ${q.targetType ? sql`and ${ELEMENT_TYPE} = ${q.targetType === 'block' ? 'resource' : q.targetType}` : sql``}
    ${q.categoryId ? sql`and exists (select 1 from courses cc where cc.id = any(i.course_ids) and cc.category_id = ${q.categoryId}::uuid)` : sql``}
    ${q.authorId ? sql`and ${q.authorId}::uuid = any(${authorIdsSql('i')})` : sql``}`
}

/** Жалобы периода (числитель) — заявители отобраны каркасом. */
function complaintsCte(q: ContentQualityQuery, f: Frame): SQL {
  return sql`
    select r.id as report_id, r.issue_id, r.user_id, r.created_at,
           ${ELEMENT_TYPE} as el_type, i.target_id, i.course_ids, i.resolution
      from content_reports r
      join content_issues i on i.id = r.issue_id
      join users u on u.id = r.user_id
      ${frameJoins()}
     where true ${peopleWhere(f)} ${periodSql(sql`r.created_at`, q)} ${issueWhere(q)}`
}

/**
 * Прохождения элемента за период (знаменатель). Материал, урок и практикум проходят в уроке
 * курса — это открытие урока (`lesson_progress.first_opened_at`); тест — старт попытки; вопрос —
 * старт попытки, в снимке которой он стоит. У опроса, статьи и медиа своей меры прохождения нет:
 * строка остаётся без нормировки и уходит вниз, а не в топ.
 */
async function elementPasses(tx: TenantTx, elType: string, targetId: string, q: ContentQualityQuery, f: Frame): Promise<number> {
  let source: SQL | null = null
  if (elType === 'lesson' || elType === 'resource' || elType === 'workshop') {
    const lessonMatch = elType === 'lesson'
      ? sql`lp.lesson_id = ${targetId}::uuid`
      : sql`lp.lesson_id in (select l.id from lessons l where l.item_type = ${elType} and l.item_id = ${targetId}::uuid)`
    source = sql`
      select count(*)::int as n from lesson_progress lp
        join enrollments e on e.id = lp.enrollment_id
        join users u on u.id = e.user_id
        ${frameJoins()}
       where ${lessonMatch} ${peopleWhere(f)} ${periodSql(sql`lp.first_opened_at`, q)}`
  }
  else if (elType === 'quiz' || elType === 'question') {
    const attemptMatch = elType === 'quiz'
      ? sql`a.quiz_id = ${targetId}::uuid`
      : sql`exists (select 1 from jsonb_array_elements(case jsonb_typeof(a.snapshot) when 'array' then a.snapshot
                                                          else coalesce(a.snapshot->'questions', '[]'::jsonb) end) sq
                     where sq->>'id' = ${targetId})`
    source = sql`
      select count(*)::int as n from attempts a
        join users u on u.id = a.user_id
        ${frameJoins()}
       where ${attemptMatch} and a.status <> 'annulled' ${peopleWhere(f)} ${periodSql(sql`a.started_at`, q)}`
  }
  if (!source) return 0
  const [r] = await tx.execute(source) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

/** Прохождения курса за период: начатые записи на курс (строки «по трекам»). */
async function coursePasses(tx: TenantTx, courseId: string, q: ContentQualityQuery, f: Frame): Promise<number> {
  const [r] = await tx.execute(sql`
    select count(*)::int as n from enrollments e
      join users u on u.id = e.user_id
      ${frameJoins()}
     where e.subject_id = ${courseId}::uuid and e.started_at is not null
       ${peopleWhere(f)} ${periodSql(sql`e.started_at`, q)}`) as unknown as { n: number }[]
  return Number(r?.n ?? 0)
}

/** Карточки строки: средний срок до «Виправлено» и сколько открыто сейчас. */
async function issueStats(tx: TenantTx, issueIds: string[]): Promise<{ avgDaysToFix: number | null, openNow: number }> {
  if (!issueIds.length) return { avgDaysToFix: null, openNow: 0 }
  const [r] = await tx.execute(sql`
    select (select round(avg(extract(epoch from (f.fixed_at - i.first_reported_at)) / 86400)::numeric, 1)::float
              from content_issues i
              join lateral (select min(e.created_at) as fixed_at from content_issue_events e
                             where e.issue_id = i.id and e.kind = 'status_changed' and e.to_status = 'fixed') f on f.fixed_at is not null
             where i.id = any(${uuidArray(issueIds)})) as avg_days,
           (select count(*)::int from content_issues i where i.id = any(${uuidArray(issueIds)}) and i.status in (${OPEN})) as open_now`) as unknown as { avg_days: number | null, open_now: number }[]
  return { avgDaysToFix: r?.avg_days == null ? null : Number(r.avg_days), openNow: Number(r?.open_now ?? 0) }
}

/** Название, треки и авторы элемента — для колонок «Елемент», «Трек», «Автор». */
async function elementMeta(tx: TenantTx, issueId: string): Promise<{ title: string, tracks: IssueTrack[], authors: string[] }> {
  const [r] = await tx.execute(sql`
    select i.title,
           (select coalesce(json_agg(json_build_object('id', c.id, 'title', c.title) order by c.title), '[]'::json)
              from courses c where c.id = any(i.course_ids)) as tracks,
           (select coalesce(array_agg(a.full_name order by x.ord), '{}') from unnest(${authorIdsSql('i')}) with ordinality x(id, ord)
              left join users a on a.id = x.id) as authors
      from content_issues i where i.id = ${issueId}::uuid`) as unknown as { title: string, tracks: IssueTrack[], authors: string[] }[]
  return { title: r?.title ?? '', tracks: r?.tracks ?? [], authors: (r?.authors ?? []).filter(Boolean) }
}

interface Group { key: string, elType: string, targetId: string, complaints: number, confirmed: number, rejected: number, issueIds: string[] }

/**
 * Отчёт (§9, §10 `GET /reports/content-quality`). `groupBy = 'course'` сворачивает строки в
 * треки: жалоба на элемент курса — жалоба на курс, прохождение — начатая запись на курс.
 * Критерий 9 сформулирован именно для курсов; строки по элементам — основной вид экрана.
 */
export async function contentQualityReport(v: Viewer, q: ContentQualityQuery): Promise<ContentQualityReport> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const f: Frame = { scope: v.scope, includeArchived: q.includeArchived, locationId: q.locationId }
    const byCourse = q.groupBy === 'course'
    const groups = await tx.execute(sql`
      with rep as (${complaintsCte(q, f)})
      ${byCourse
        ? sql`select 'course' as el_type, c.id as target_id,
                     count(*)::int as complaints,
                     count(*) filter (where rep.resolution in (${CONFIRMED}))::int as confirmed,
                     count(*) filter (where rep.resolution in (${REJECTED}))::int as rejected,
                     array_agg(distinct rep.issue_id) as issue_ids
                from rep cross join lateral unnest(rep.course_ids) c(id)
               group by c.id`
        : sql`select rep.el_type, rep.target_id,
                     count(*)::int as complaints,
                     count(*) filter (where rep.resolution in (${CONFIRMED}))::int as confirmed,
                     count(*) filter (where rep.resolution in (${REJECTED}))::int as rejected,
                     array_agg(distinct rep.issue_id) as issue_ids
                from rep group by rep.el_type, rep.target_id`}`) as unknown as { el_type: string, target_id: string, complaints: number, confirmed: number, rejected: number, issue_ids: string[] }[]

    const list: Group[] = groups.map(g => ({
      key: `${g.el_type}:${g.target_id}`,
      elType: g.el_type,
      targetId: g.target_id,
      complaints: Number(g.complaints),
      confirmed: Number(g.confirmed),
      rejected: Number(g.rejected),
      issueIds: g.issue_ids ?? [],
    }))

    const rows: ContentQualityRow[] = []
    for (const g of list) {
      const passes = byCourse ? await coursePasses(tx, g.targetId, q, f) : await elementPasses(tx, g.elType, g.targetId, q, f)
      const stats = await issueStats(tx, g.issueIds)
      let meta: { title: string, tracks: IssueTrack[], authors: string[] }
      if (byCourse) {
        const [c] = await tx.execute(sql`
          select c.title, a.full_name as author
            from courses c left join users a on a.id = c.created_by
           where c.id = ${g.targetId}::uuid`) as unknown as { title: string, author: string | null }[]
        meta = { title: c?.title ?? '', tracks: c ? [{ id: g.targetId, title: c.title }] : [], authors: c?.author ? [c.author] : [] }
      }
      else {
        meta = await elementMeta(tx, g.issueIds[0]!)
      }
      rows.push({
        key: g.key,
        targetType: g.elType as ContentQualityRow['targetType'],
        targetId: g.targetId,
        title: meta.title,
        tracks: meta.tracks,
        authors: meta.authors,
        passes,
        complaints: g.complaints,
        per100: perHundred(g.complaints, passes),
        confirmed: g.confirmed,
        rejected: g.rejected,
        avgDaysToFix: stats.avgDaysToFix,
        openNow: stats.openNow,
      })
    }
    rows.sort(compareQuality)

    const complaints = rows.reduce((s, r) => s + r.complaints, 0)
    const passes = rows.reduce((s, r) => s + r.passes, 0)

    let people: Record<string, unknown>[] | null = null
    if (q.drillKey) {
      const [kind, id] = q.drillKey.split(':')
      if (kind && id && /^[0-9a-f-]{36}$/i.test(id)) {
        const match = kind === 'course'
          ? sql`and ${id}::uuid = any(i.course_ids)`
          : sql`and ${ELEMENT_TYPE} = ${kind} and i.target_id = ${id}::uuid`
        people = await tx.execute(sql`
          select ${frameSelect()},
                 ${frameTail({ assignedAt: sql`r.created_at`, completedAt: sql`i.closed_at`, status: sql`null`, result: sql`null` })},
                 i.issue_type, i.status as issue_status, r.comment
            from content_reports r
            join content_issues i on i.id = r.issue_id
            join users u on u.id = r.user_id
            ${frameJoins()}
           where true ${peopleWhere(f)} ${periodSql(sql`r.created_at`, q)} ${issueWhere(q)} ${match}
           order by r.created_at desc
           limit 500`) as unknown as Record<string, unknown>[]
      }
    }

    return {
      rows,
      summary: { complaints, passes, per100: perHundred(complaints, passes), openNow: rows.reduce((s, r) => s + r.openNow, 0) },
      people,
    }
  })
}
