import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import type { VacancyReportQuery } from '../../shared/schemas/vacancies'
import { recordAudit } from './audit'
import type { Viewer } from './vacancies'

/**
 * Отчёты вакансий (`docs/v2/29-vacancies.md` §9.1–§9.6; решения `v2/44` Р-VT.6…Р-VT.9).
 *
 * Все пять отчётов видят ровно те вакансии, что и реестр (`vacancies.ts#scopeCond()`): рекрутер —
 * свои и своих точек, HR и админ — все. Чужая вакансия не попадает ни строкой, ни числом.
 *
 * Люди в отчётах — только числа, кроме журнала публикаций (инициатор — сотрудник) и выгрузки
 * откликов §9.6. Каждое соединение с `users` называет вид человека явно (инвариант 17): нанятый —
 * `employee` с `converted_from_candidate_at`, прошедший отбор — кандидат или уже сотрудник.
 *
 * Период — даты по поясу тенанта включительно; по умолчанию — последние 30 дней.
 */

export interface Period { from: string, to: string }

/** Дата события по поясу тенанта — в отчётах сутки те же, что в свёртке `vacancy_stats_daily`. */
const localDay = (col: SQL) => sql`(${col} at time zone (select t.timezone from tenants t where t.id = current_setting('app.tenant_id')::uuid))::date`

async function rows<T>(tx: TenantTx, q: SQL): Promise<T[]> {
  return await tx.execute(q) as unknown as T[]
}


/** `today` — сегодняшняя дата **по поясу тенанта**: в полночь по Киеву UTC ещё во вчерашнем дне. */
export function periodOf(f: Pick<VacancyReportQuery, 'from' | 'to'>, today: string): Period {
  const to = f.to ?? today
  const from = f.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

async function tenantPeriod(tx: TenantTx, f: Pick<VacancyReportQuery, 'from' | 'to'>): Promise<Period> {
  const [r] = await rows<{ today: string }>(tx, sql`select ${localDay(sql`now()`)}::text as today`)
  return periodOf(f, r!.today)
}

/** Область видимости реестра в сыром SQL (алиас вакансии — `v`), как `scopeCond()`. */
function scopeSql(viewer: Viewer): SQL {
  if (viewer.locations === null) return sql`true`
  if (!viewer.locations.length) return sql`v.recruiter_id = ${viewer.actorId}::uuid`
  const ids = sql.join(viewer.locations.map(id => sql`${id}::uuid`), sql`, `)
  return sql`(v.location_id in (${ids}) or v.recruiter_id = ${viewer.actorId}::uuid)`
}

/** Фильтры реестра поверх области: точка, рекрутер, категория, состояние. */
function vacancyFilter(viewer: Viewer, f: VacancyReportQuery): SQL {
  const parts: SQL[] = [scopeSql(viewer)]
  if (f.locationId) parts.push(sql`v.location_id = ${f.locationId}::uuid`)
  if (f.recruiterId) parts.push(sql`v.recruiter_id = ${f.recruiterId}::uuid`)
  if (f.categoryId) parts.push(sql`v.category_id = ${f.categoryId}::uuid`)
  if (f.state) parts.push(sql`v.state = ${f.state}`)
  return sql.join(parts, sql` and `)
}

function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null
}

// ── §9.1 Эффективность вакансии ──────────────────────────────────────────────────────────

export interface EffectivenessRow {
  vacancyId: string
  title: string
  state: string
  location: string | null
  views: number
  applications: number
  accepted: number
  completed: number
  hired: number
  viewToApplyPct: number | null
  applyToCompletedPct: number | null
  daysToFirstHire: number | null
}

/**
 * §9.1. Просмотры — из свёртки `vacancy_stats_daily` (журнал попыток живёт 30 дней). Остальное —
 * **когорта откликов периода** (Р-VT.6): отклики, поданные в период (без `spam` — это не люди);
 * из них принятые; из принятых — завершившие рекрутинговый курс (`enrollments.status = 'done'`) и
 * нанятые. Так конверсии считаются по одним и тем же людям, а не по разным событиям периода.
 * «Срок до первого найма» — дни от первой публикации до первого найма по вакансии, вне периода.
 */
export async function effectivenessReport(viewer: Viewer, f: VacancyReportQuery): Promise<{ period: Period, rows: EffectivenessRow[] }> {
  let period!: Period
  const list = await withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    period = await tenantPeriod(tx, f)
    return rows<Record<string, unknown>>(tx, sql`
    with vs as (
      select v.id, v.title, v.state, v.course_id, v.published_at,
             (select l.name from locations l where l.id = v.location_id) as location
        from vacancies v where ${vacancyFilter(viewer, f)}
    ),
    views as (
      select s.vacancy_id, sum(s.views)::int as n from vacancy_stats_daily s
       where s.vacancy_id in (select id from vs) and s.day between ${period.from}::date and ${period.to}::date
       group by 1
    ),
    cohort as (
      select a.vacancy_id, a.state, a.candidate_id from vacancy_applications a
       where a.vacancy_id in (select id from vs) and a.state <> 'spam'
         and ${localDay(sql`a.created_at`)} between ${period.from}::date and ${period.to}::date
    ),
    done as (
      select c.vacancy_id, count(distinct c.candidate_id)::int as n from cohort c
        join users u on u.id = c.candidate_id and (u.kind = 'candidate' or u.kind = 'employee')
        join enrollments e on e.user_id = u.id and e.status = 'done'
         and e.subject_id = (select vs.course_id from vs where vs.id = c.vacancy_id)
       group by 1
    ),
    hired as (
      select c.vacancy_id, count(distinct u.id)::int as n from cohort c
        join users u on u.id = c.candidate_id and u.kind = 'employee' and u.converted_from_candidate_at is not null
       group by 1
    ),
    first_hire as (
      select u.vacancy_id, min(u.hired_at) as at from users u
       where u.kind = 'employee' and u.converted_from_candidate_at is not null and u.hired_at is not null
         and u.vacancy_id in (select id from vs)
       group by 1
    )
    select vs.id, vs.title, vs.state, vs.location,
           coalesce(views.n, 0) as views,
           (select count(*)::int from cohort c where c.vacancy_id = vs.id) as applications,
           (select count(*)::int from cohort c where c.vacancy_id = vs.id and c.state in ('accepted', 'merged')) as accepted,
           coalesce(done.n, 0) as completed,
           coalesce(hired.n, 0) as hired,
           case when first_hire.at is not null and vs.published_at is not null
                then greatest(0, first_hire.at::date - ${localDay(sql`vs.published_at`)}) end as days_to_first_hire
      from vs
      left join views on views.vacancy_id = vs.id
      left join done on done.vacancy_id = vs.id
      left join hired on hired.vacancy_id = vs.id
      left join first_hire on first_hire.vacancy_id = vs.id
     order by vs.title
  `)
  })
  return {
    period,
    rows: list.map((r) => {
      const views = Number(r.views)
      const applications = Number(r.applications)
      const completed = Number(r.completed)
      return {
        vacancyId: String(r.id),
        title: String(r.title),
        state: String(r.state),
        location: (r.location as string | null) ?? null,
        views,
        applications,
        accepted: Number(r.accepted),
        completed,
        hired: Number(r.hired),
        viewToApplyPct: pct(applications, views),
        applyToCompletedPct: pct(completed, applications),
        daysToFirstHire: r.days_to_first_hire == null ? null : Number(r.days_to_first_hire),
      }
    }),
  }
}

// ── §9.2 Эффективность площадок ──────────────────────────────────────────────────────────

export interface BoardRow {
  accountId: string
  provider: string
  ownerType: string
  owner: string | null
  activePublications: number
  applications: number
  hired: number
  budget: number | null
  costPerHire: number | null
}

/**
 * §9.2. Отклик привязан к публикации меткой `?s=<id публикации>` в ссылке, которую получает
 * площадка (§7.19, `vacancyPublications.ts#buildPayload()`), — отсюда «откликов» и «нанято»
 * аккаунта. `source_budget` задан на вакансию, а не на площадку: бюджет вакансии делится поровну
 * между аккаунтами, где она была опубликована (Р-VT.7), — иначе одна вакансия на двух площадках
 * удвоила бы расходы.
 */
export async function boardsReport(viewer: Viewer, f: VacancyReportQuery): Promise<{ period: Period, rows: BoardRow[] }> {
  let period!: Period
  const list = await withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    period = await tenantPeriod(tx, f)
    return rows<Record<string, unknown>>(tx, sql`
    with vs as (select v.id, v.source_budget from vacancies v where ${vacancyFilter(viewer, f)}),
    pubs as (
      select p.id, p.vacancy_id, p.account_id, p.state from vacancy_publications p
       where p.vacancy_id in (select id from vs) and p.state <> 'failed'
    ),
    share as (
      select vs.id as vacancy_id, vs.source_budget / nullif(count(distinct pubs.account_id), 0) as part
        from vs join pubs on pubs.vacancy_id = vs.id group by vs.id, vs.source_budget
    ),
    apps as (
      select a.id, a.candidate_id, p.account_id from vacancy_applications a
        join pubs p on p.id::text = a.source_detail
       where a.source = 'job_board' and a.state <> 'spam'
         and ${localDay(sql`a.created_at`)} between ${period.from}::date and ${period.to}::date
    )
    select acc.id, acc.provider, acc.owner_type,
           (select u2.full_name from users u2 where u2.id = acc.owner_user_id and u2.kind = 'employee') as owner,
           (select count(*)::int from pubs where pubs.account_id = acc.id and pubs.state in ('active', 'manual')) as active_publications,
           (select count(*)::int from apps where apps.account_id = acc.id) as applications,
           (select count(distinct u.id)::int from apps
              join users u on u.id = apps.candidate_id and u.kind = 'employee' and u.converted_from_candidate_at is not null
             where apps.account_id = acc.id) as hired,
           (select sum(share.part) from share where share.vacancy_id in (select pubs.vacancy_id from pubs where pubs.account_id = acc.id)) as budget
      from job_board_accounts acc
     where acc.id in (select account_id from pubs) ${f.provider ? sql`and acc.provider = ${f.provider}` : sql``}
     order by acc.provider, acc.owner_type
  `)
  })
  return {
    period,
    rows: list.map((r) => {
      const hired = Number(r.hired)
      const budget = r.budget == null ? null : Math.round(Number(r.budget) * 100) / 100
      return {
        accountId: String(r.id),
        provider: String(r.provider),
        ownerType: String(r.owner_type),
        owner: (r.owner as string | null) ?? null,
        activePublications: Number(r.active_publications),
        applications: Number(r.applications),
        hired,
        budget,
        costPerHire: budget != null && hired > 0 ? Math.round((budget / hired) * 100) / 100 : null,
      }
    }),
  }
}

// ── §9.3 Журнал публикаций ───────────────────────────────────────────────────────────────

export interface PublicationLogRow {
  publicationId: string
  vacancy: string
  provider: string
  ownerType: string
  owner: string | null
  initiator: string | null
  state: string
  publishedAt: string | null
  expiresAt: string | null
  attempts: number
  lastError: string | null
}

/** §9.3. Строки, созданные в период; фильтры — площадка и состояние вакансии. Последние 1000. */
export async function publicationsReport(viewer: Viewer, f: VacancyReportQuery): Promise<{ period: Period, rows: PublicationLogRow[] }> {
  let period!: Period
  const list = await withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    period = await tenantPeriod(tx, f)
    return rows<Record<string, unknown>>(tx, sql`
    select p.id, v.title, acc.provider, acc.owner_type, p.state, p.published_at, p.expires_at, p.attempts,
           coalesce(p.last_error, p.last_error_code) as last_error,
           (select u2.full_name from users u2 where u2.id = acc.owner_user_id and u2.kind = 'employee') as owner,
           (select u3.full_name from users u3 where u3.id = p.requested_by and u3.kind = 'employee') as initiator
      from vacancy_publications p
      join vacancies v on v.id = p.vacancy_id
      join job_board_accounts acc on acc.id = p.account_id
     where ${vacancyFilter(viewer, f)}
       and ${localDay(sql`p.created_at`)} between ${period.from}::date and ${period.to}::date
       ${f.provider ? sql`and acc.provider = ${f.provider}` : sql``}
     order by p.created_at desc
     limit 1000
  `)
  })
  return {
    period,
    rows: list.map(r => ({
      publicationId: String(r.id),
      vacancy: String(r.title),
      provider: String(r.provider),
      ownerType: String(r.owner_type),
      owner: (r.owner as string | null) ?? null,
      initiator: (r.initiator as string | null) ?? null,
      state: String(r.state),
      publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
      expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
      attempts: Number(r.attempts),
      lastError: (r.last_error as string | null) ?? null,
    })),
  }
}

// ── §9.4 Защита публичных страниц ────────────────────────────────────────────────────────

export interface ProtectionRow {
  day: string
  views: number
  submits: number
  blocked: number
  pendingReview: number
  spam: number
  topReasons: { reason: string, n: number }[]
}

/**
 * §9.4. По суткам: просмотры, отправки и блокировки — из свёртки; «на модерації» и «спам» — по
 * текущему состоянию откликов, поданных в эти сутки. Топ-5 причин — блокировки формы вместе с
 * признаками откликов (`spam_reasons`). IP нет ни в каком виде — даже хэша.
 */
export async function protectionReport(viewer: Viewer, f: VacancyReportQuery): Promise<{ period: Period, rows: ProtectionRow[], topReasons: { reason: string, n: number }[] }> {
  let period!: Period
  const { stats, apps, reasons } = await withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    period = await tenantPeriod(tx, f)
    const vs = sql`(select v.id from vacancies v where ${vacancyFilter(viewer, f)})`
    const stats = await rows<Record<string, unknown>>(tx, sql`
      select s.day::text as day, sum(s.views)::int as views, sum(s.submits)::int as submits, sum(s.blocked)::int as blocked,
             coalesce(jsonb_agg(s.block_reasons) filter (where s.block_reasons <> '{}'::jsonb), '[]'::jsonb) as reasons
        from vacancy_stats_daily s
       where s.vacancy_id in ${vs} and s.day between ${period.from}::date and ${period.to}::date
       group by s.day
    `)
    const apps = await rows<Record<string, unknown>>(tx, sql`
      select ${localDay(sql`a.created_at`)}::text as day,
             count(*) filter (where a.state = 'pending_review')::int as pending_review,
             count(*) filter (where a.state = 'spam')::int as spam
        from vacancy_applications a
       where a.vacancy_id in ${vs} and ${localDay(sql`a.created_at`)} between ${period.from}::date and ${period.to}::date
       group by 1
    `)
    const reasons = await rows<Record<string, unknown>>(tx, sql`
      select ${localDay(sql`a.created_at`)}::text as day, r.reason, count(*)::int as n
        from vacancy_applications a, unnest(a.spam_reasons) as r(reason)
       where a.vacancy_id in ${vs} and ${localDay(sql`a.created_at`)} between ${period.from}::date and ${period.to}::date
       group by 1, 2
    `)
    return { stats, apps, reasons }
  })

  const byDay = new Map<string, ProtectionRow & { counts: Map<string, number> }>()
  const row = (day: string) => {
    let r = byDay.get(day)
    if (!r) {
      r = { day, views: 0, submits: 0, blocked: 0, pendingReview: 0, spam: 0, topReasons: [], counts: new Map() }
      byDay.set(day, r)
    }
    return r
  }
  const total = new Map<string, number>()
  const add = (r: { counts: Map<string, number> }, reason: string, n: number) => {
    r.counts.set(reason, (r.counts.get(reason) ?? 0) + n)
    total.set(reason, (total.get(reason) ?? 0) + n)
  }
  for (const s of stats) {
    const r = row(String(s.day))
    r.views = Number(s.views)
    r.submits = Number(s.submits)
    r.blocked = Number(s.blocked)
    for (const obj of (s.reasons as Record<string, number>[])) for (const [k, n] of Object.entries(obj)) add(r, k, Number(n))
  }
  for (const a of apps) {
    const r = row(String(a.day))
    r.pendingReview = Number(a.pending_review)
    r.spam = Number(a.spam)
  }
  for (const x of reasons) add(row(String(x.day)), String(x.reason), Number(x.n))

  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, n]) => ({ reason, n }))
  return {
    period,
    rows: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).map(({ counts, ...r }) => ({ ...r, topReasons: top(counts) })),
    topReasons: top(total),
  }
}

// ── §9.5 Использование ИИ ────────────────────────────────────────────────────────────────

export interface AiUsageRow {
  userId: string
  user: string | null
  target: string
  generations: number
  opsCharged: number
  published: number
  publishedUnedited: number
  uneditedPct: number | null
}

/**
 * §9.5. Генерации периода по автору и блоку: успешные, списано операций (всех вызовов, включая
 * неудачные — у них `ops_charged = 0`). «Доля опубликованных без правки человеком» — среди
 * опубликованных вакансий, где **текущий** текст блока сгенерирован этим человеком (`ai_blocks`):
 * сколько из них ушли на страницу без `editedAt` (только «Текст перевірено»). У критериев такой
 * доли нет — они в `ai_blocks` не живут и без явного сохранения не появляются (§7.11).
 */
export async function aiUsageReport(viewer: Viewer, f: VacancyReportQuery): Promise<{ period: Period, rows: AiUsageRow[] }> {
  let period!: Period
  const list = await withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    period = await tenantPeriod(tx, f)
    return rows<Record<string, unknown>>(tx, sql`
    with vs as (select v.id, v.published_at, v.ai_blocks from vacancies v where ${vacancyFilter(viewer, f)}),
    gen as (
      select g.author_id, g.target,
             count(*) filter (where g.status = 'ok')::int as generations,
             sum(g.ops_charged)::int as ops
        from vacancy_ai_generations g
       where g.vacancy_id in (select id from vs)
         and ${localDay(sql`g.created_at`)} between ${period.from}::date and ${period.to}::date
       group by 1, 2
    ),
    pub as (
      select (b.value ->> 'generatedBy')::uuid as author_id, b.key as target,
             count(*)::int as published,
             count(*) filter (where b.value ->> 'editedAt' is null)::int as unedited
        from vs, jsonb_each(vs.ai_blocks) as b(key, value)
       where vs.published_at is not null and b.value ? 'generatedBy'
       group by 1, 2
    )
    select gen.author_id, gen.target, gen.generations, gen.ops,
           (select u2.full_name from users u2 where u2.id = gen.author_id and u2.kind = 'employee') as author,
           coalesce(pub.published, 0) as published, coalesce(pub.unedited, 0) as unedited
      from gen left join pub on pub.author_id = gen.author_id and pub.target = gen.target
     order by author, gen.target
  `)
  })
  return {
    period,
    rows: list.map((r) => {
      const published = Number(r.published)
      const unedited = Number(r.unedited)
      const isText = r.target !== 'criteria'
      return {
        userId: String(r.author_id),
        user: (r.author as string | null) ?? null,
        target: String(r.target),
        generations: Number(r.generations),
        opsCharged: Number(r.ops ?? 0),
        published,
        publishedUnedited: unedited,
        uneditedPct: isText ? pct(unedited, published) : null,
      }
    }),
  }
}

// ── Выгрузка тех же строк (docs/22 §7) ───────────────────────────────────────────────────

export const VACANCY_REPORTS = {
  effectiveness: {
    run: effectivenessReport,
    rows: (r: Awaited<ReturnType<typeof effectivenessReport>>) => r.rows.map(x => ({
      'Вакансія': x.title, 'Точка': x.location ?? '', 'Стан': x.state, 'Переглядів': x.views, 'Відгуків': x.applications,
      'Прийнято': x.accepted, 'Завершили відбір': x.completed, 'Найнято': x.hired,
      'Перегляд → відгук, %': x.viewToApplyPct ?? '', 'Відгук → завершив відбір, %': x.applyToCompletedPct ?? '',
      'Днів до першого найму': x.daysToFirstHire ?? '',
    })),
  },
  boards: {
    run: boardsReport,
    rows: (r: Awaited<ReturnType<typeof boardsReport>>) => r.rows.map(x => ({
      'Майданчик': x.provider, 'Акаунт': x.ownerType, 'Власник': x.owner ?? '', 'Активних публікацій': x.activePublications,
      'Відгуків': x.applications, 'Найнято': x.hired, 'Бюджет': x.budget ?? '', 'Вартість найму': x.costPerHire ?? '',
    })),
  },
  publications: {
    run: publicationsReport,
    rows: (r: Awaited<ReturnType<typeof publicationsReport>>) => r.rows.map(x => ({
      'Вакансія': x.vacancy, 'Майданчик': x.provider, 'Акаунт': x.ownerType, 'Власник акаунта': x.owner ?? '',
      'Ініціатор': x.initiator ?? '', 'Стан': x.state, 'Опубліковано': x.publishedAt ?? '', 'Діє до': x.expiresAt ?? '',
      'Повторів': x.attempts, 'Остання помилка': x.lastError ?? '',
    })),
  },
  protection: {
    run: protectionReport,
    rows: (r: Awaited<ReturnType<typeof protectionReport>>) => r.rows.map(x => ({
      'Доба': x.day, 'Переглядів': x.views, 'Відправлень': x.submits, 'Заблоковано': x.blocked,
      'На модерації': x.pendingReview, 'Спам': x.spam, 'Топ-5 причин': x.topReasons.map(t => `${t.reason}: ${t.n}`).join(', '),
    })),
  },
  ai: {
    run: aiUsageReport,
    rows: (r: Awaited<ReturnType<typeof aiUsageReport>>) => r.rows.map(x => ({
      'Користувач': x.user ?? '', 'Блок': x.target, 'Генерацій': x.generations, 'Списано операцій': x.opsCharged,
      'Опубліковано': x.published, 'Без правки людиною': x.publishedUnedited, 'Частка без правки, %': x.uneditedPct ?? '',
    })),
  },
} as const

export type VacancyReportName = keyof typeof VACANCY_REPORTS

// ── §9.6 Выгрузка откликов ───────────────────────────────────────────────────────────────

/**
 * §9.6. Имя, контакт, источник, дата, состояние, признаки спама, ссылка на кандидата. Контакты
 * открыты, поэтому выгрузка — только смотрящему вакансии «в полном объёме» (область на весь
 * тенант, `viewer.locations === null`, Р-VT.9); факт и число строк — в `audit_log`, как у
 * выгрузки кандидатов (`28` §9.6). Чужая вакансия — `null` (→ `404`).
 */
export async function applicationsExport(viewer: Viewer, vacancyId: string, format: string): Promise<Record<string, unknown>[] | null> {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  return withTenant(viewer.tenantId, viewer.actorId, async (tx) => {
    const [vac] = await rows<{ id: string, title: string }>(tx, sql`select v.id, v.title from vacancies v where v.id = ${vacancyId}::uuid and ${scopeSql(viewer)}`)
    if (!vac) return null
    const list = await rows<Record<string, unknown>>(tx, sql`
      select a.id, a.full_name, a.phone, a.email, a.source, a.source_detail, a.created_at, a.state, a.spam_reasons, a.candidate_id
        from vacancy_applications a where a.vacancy_id = ${vacancyId}::uuid order by a.created_at desc
    `)
    const out = list.map(a => ({
      "Ім'я": a.full_name,
      'Контакт': [a.phone, a.email].filter(Boolean).join(', '),
      'Джерело': a.source_detail ? `${a.source} (${a.source_detail})` : a.source,
      'Отримано': new Date(a.created_at as string).toISOString(),
      'Стан': a.state,
      'Ознаки спаму': ((a.spam_reasons as string[]) ?? []).join(', '),
      'Кандидат': a.candidate_id ? `${base}/admin/candidates/${a.candidate_id}` : '',
    }))
    await recordAudit(tx, {
      tenantId: viewer.tenantId, actorId: viewer.actorId, action: 'vacancy.applications_export', entity: 'vacancy', entityId: vacancyId,
      after: { format, rows: out.length },
    })
    return out
  })
}
