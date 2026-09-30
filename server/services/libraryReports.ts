import { sql, type SQL } from 'drizzle-orm'
import type { TenantTx } from '../utils/withTenant'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import type { LibraryActor } from './library'
import {
  LIBRARY_REPORT_MAX_ROWS,
  type LibraryOrphanScanReport, type LibraryProposalReportRow, type LibraryReportQuery, type LibraryScansView,
  type LibraryStaleReportRow, type LibraryUsageReportRow, type LibraryVersionRetireReport,
} from '../../shared/schemas/library'

/**
 * Отчёты библиотеки модулей и две служебные задачи (`docs/v2/31-module-library.md` §9, §11).
 *
 * **Отчёты** читают под RLS того, кто смотрит. Видимость — как у самой библиотеки (Р-31.6:
 * общий ресурс тенанта, не сужается точкой): «Використання» и «Застарілі посилання» видит любой
 * носитель `library.view`; «Пропозиції» — куратор (`library.publish`) все, остальные только свои,
 * как `GET /library/proposals`. Экран показывает те же строки, что уходят в выгрузку.
 *
 * **Служебные задачи** (`library.orphan_scan`, `library.version_retire`) идут от имени системы
 * (`actorId = null`) и пишут отчёт в `audit_log`; `GET /library/scans` отдаёт последний.
 */

interface Ctx { tenantId: string, actorId: string }

const DAY_MS = 86_400_000

/** Период по умолчанию — последние 30 дней; `to` включительно. */
function period(q: LibraryReportQuery, now = new Date()): { from: Date, to: Date } {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 29 * DAY_MS)
  return { from, to: new Date(to.getTime() + DAY_MS) }
}

const iso = (v: Date | string | null): string | null => v === null ? null : new Date(v).toISOString()
const and = (parts: (SQL | null)[]): SQL => {
  const list = parts.filter((p): p is SQL => p !== null)
  return list.length ? sql.join(list, sql` and `) : sql`true`
}

// ── «Використання бібліотеки» ───────────────────────────────────────────────────────────

/**
 * Строка на модуль: версия, места (активные и из них устаревшие — по факту номеров, а не по
 * флагу `is_stale`), открытия за период и доля завершения. Открытие — первое открытие урока
 * курса, закреплённого на любой версии модуля (`lesson_progress`), или снимка версии, выданного
 * узлом траектории (`resource_progress.resource_version_id`, `trajectories.ts#createNodeAssignment`).
 * Урок, отвязанный с копией, в модуль больше не считается — его тело уже своё.
 */
export async function libraryUsageReport(ctx: Ctx, q: LibraryReportQuery): Promise<LibraryUsageReportRow[]> {
  const { from, to } = period(q)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = and([
      q.kind ? sql`m.content_kind = ${q.kind}` : null,
      q.categoryId ? sql`m.category_id = ${q.categoryId}::uuid` : null,
      q.ownerId ? sql`m.owner_id = ${q.ownerId}::uuid` : null,
      q.onlyUnused ? sql`coalesce(us.usages, 0) = 0` : null,
    ])
    const rows = await tx.execute(sql`
      with vers as (
        select v.library_module_id as module_id, v.id as version_id, l.resource_version_id
          from library_module_versions v join lessons l on l.id = v.lesson_id
      ), opens as (
        select vv.module_id, lp.status
          from lesson_progress lp
          join lessons cl on cl.id = lp.lesson_id
          join vers vv on vv.version_id = cl.library_version_id
         where lp.first_opened_at >= ${from.toISOString()}::timestamptz and lp.first_opened_at < ${to.toISOString()}::timestamptz
        union all
        select vv.module_id, rp.status
          from resource_progress rp
          join vers vv on vv.resource_version_id = rp.resource_version_id
         where rp.first_opened_at >= ${from.toISOString()}::timestamptz and rp.first_opened_at < ${to.toISOString()}::timestamptz
      ), op as (
        select module_id, count(*)::int as opens, count(*) filter (where status = 'completed')::int as done
          from opens group by module_id
      ), us as (
        select u.library_module_id as module_id, count(*)::int as usages,
               count(*) filter (where v.version < cv.version)::int as stale
          from library_module_usages u
          join library_module_versions v on v.id = u.version_id
          join library_modules m2 on m2.id = u.library_module_id
          left join library_module_versions cv on cv.id = m2.current_version_id
         where u.detached_at is null
         group by u.library_module_id
      )
      select m.id, m.title, m.content_kind, m.status, m.category_id, c.name as category, m.owner_id, o.full_name as owner,
             cv.version, cv.published_at, coalesce(us.usages, 0) as usages, coalesce(us.stale, 0) as stale,
             coalesce(op.opens, 0) as opens, op.done, m.updated_at
        from library_modules m
        left join course_categories c on c.id = m.category_id
        left join users o on o.id = m.owner_id
        left join library_module_versions cv on cv.id = m.current_version_id
        left join us on us.module_id = m.id
        left join op on op.module_id = m.id
       where ${where}
       order by m.title, m.id
       limit ${LIBRARY_REPORT_MAX_ROWS}
    `) as unknown as {
      id: string, title: string, content_kind: string, status: string, category_id: string | null, category: string | null, owner_id: string, owner: string | null
      version: number | null, published_at: Date | string | null, usages: number, stale: number, opens: number, done: number | null
      updated_at: Date | string
    }[]
    return rows.map(r => ({
      moduleId: r.id,
      title: r.title,
      contentKind: r.content_kind,
      status: r.status,
      categoryId: r.category_id,
      category: r.category,
      ownerId: r.owner_id,
      owner: r.owner,
      version: r.version === null ? null : Number(r.version),
      versionAt: iso(r.published_at),
      usages: Number(r.usages),
      stale: Number(r.stale),
      opens: Number(r.opens),
      completionPct: Number(r.opens) ? Math.round((Number(r.done ?? 0) / Number(r.opens)) * 1000) / 10 : null,
      updatedAt: iso(r.updated_at)!,
    }))
  })
}

// ── «Застарілі посилання» ───────────────────────────────────────────────────────────────

/**
 * Активные места, закреплённые не на последней версии. Автор контейнера — тот же, кому идут
 * уведомления §8 (`containerAuthorOf` в `libraryUsages.ts`): создатель траектории (или последний
 * правивший), создатель курса. Сортировка — самые отставшие сверху.
 */
export async function libraryStaleReport(ctx: Ctx, q: LibraryReportQuery, now = new Date()): Promise<LibraryStaleReportRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const where = and([
      q.authorId ? sql`x.author_id = ${q.authorId}::uuid` : null,
      q.minLag ? sql`x.lag >= ${q.minLag}` : null,
    ])
    const rows = await tx.execute(sql`
      with x as (
        select u.id, u.container_type, u.container_id, u.container_title, u.holder_title,
               m.id as module_id, m.title as module_title, v.version as pinned, cv.version as latest,
               cv.version - v.version as lag,
               (select min(nv.published_at) from library_module_versions nv
                 where nv.library_module_id = m.id and nv.version > v.version) as newer_at,
               case when u.container_type = 'trajectory' then coalesce(t.created_by, t.updated_by) else c.created_by end as author_id
          from library_module_usages u
          join library_modules m on m.id = u.library_module_id
          join library_module_versions v on v.id = u.version_id
          join library_module_versions cv on cv.id = m.current_version_id
          left join trajectories t on u.container_type = 'trajectory' and t.id = u.container_id
          left join courses c on u.container_type = 'course' and c.id = u.container_id
         where u.detached_at is null and cv.version > v.version
      )
      select x.*, a.full_name as author
        from x left join users a on a.id = x.author_id
       where ${where}
       order by x.lag desc, x.newer_at, x.id
       limit ${LIBRARY_REPORT_MAX_ROWS}
    `) as unknown as {
      id: string, container_type: string, container_id: string, container_title: string, holder_title: string | null
      module_id: string, module_title: string, pinned: number, latest: number, lag: number, newer_at: Date | string
      author_id: string | null, author: string | null
    }[]
    return rows.map(r => ({
      usageId: r.id,
      containerType: r.container_type,
      containerId: r.container_id,
      containerTitle: r.container_title,
      holderTitle: r.holder_title,
      moduleId: r.module_id,
      moduleTitle: r.module_title,
      pinnedVersion: Number(r.pinned),
      latestVersion: Number(r.latest),
      lag: Number(r.lag),
      daysSinceNewer: Math.max(0, Math.floor((now.getTime() - new Date(r.newer_at).getTime()) / DAY_MS)),
      authorId: r.author_id,
      author: r.author,
    }))
  })
}

// ── «Пропозиції до бібліотеки» ──────────────────────────────────────────────────────────

/** Куратор видит все предложения, остальные — только свои (как `listProposals`). */
export async function libraryProposalsReport(actor: LibraryActor, q: LibraryReportQuery): Promise<LibraryProposalReportRow[]> {
  const hasPeriod = !!(q.from || q.to)
  const { from, to } = period(q)
  return withTenant(actor.tenantId, actor.actorId, async (tx) => {
    const where = and([
      q.status ? sql`p.status = ${q.status}` : null,
      hasPeriod ? sql`p.created_at >= ${from.toISOString()}::timestamptz and p.created_at < ${to.toISOString()}::timestamptz` : null,
      actor.publish ? null : sql`p.proposed_by = ${actor.actorId}::uuid`,
    ])
    const rows = await tx.execute(sql`
      select p.id, l.title as lesson_title, c.title as container_title, pb.full_name as proposed_by, p.created_at,
             p.status, db.full_name as decided_by, p.decision_comment, p.library_module_id
        from library_module_proposals p
        left join lessons l on l.id = p.source_lesson_id
        left join courses c on p.source_container_type = 'course' and c.id = p.source_container_id
        left join users pb on pb.id = p.proposed_by
        left join users db on db.id = p.decided_by
       where ${where}
       order by p.created_at desc, p.id
       limit ${LIBRARY_REPORT_MAX_ROWS}
    `) as unknown as {
      id: string, lesson_title: string | null, container_title: string | null, proposed_by: string | null, created_at: Date | string
      status: string, decided_by: string | null, decision_comment: string | null, library_module_id: string | null
    }[]
    return rows.map(r => ({
      id: r.id,
      sourceLessonTitle: r.lesson_title ?? '',
      containerTitle: r.container_title,
      proposedBy: r.proposed_by ?? '',
      createdAt: iso(r.created_at)!,
      status: r.status,
      decidedBy: r.decided_by,
      decisionComment: r.decision_comment,
      libraryModuleId: r.library_module_id,
    }))
  })
}

/** Плоские строки выгрузки (`report.export`, `reportExports.ts#reportRows`): колонки §9 в порядке документа. */
export async function libraryReportRows(actor: LibraryActor, kind: string, q: LibraryReportQuery): Promise<Record<string, unknown>[]> {
  if (kind === 'usage') {
    return (await libraryUsageReport(actor, q)).map(r => ({
      module: r.title, kind: r.contentKind, status: r.status, category: r.category ?? '', owner: r.owner ?? '',
      version: r.version ?? '', version_at: r.versionAt ?? '', usages: r.usages, stale: r.stale, opens: r.opens,
      completion_pct: r.completionPct ?? '', updated_at: r.updatedAt,
    }))
  }
  if (kind === 'stale') {
    return (await libraryStaleReport(actor, q)).map(r => ({
      container_type: r.containerType, container: r.containerTitle, holder: r.holderTitle ?? '', module: r.moduleTitle,
      pinned_version: r.pinnedVersion, latest_version: r.latestVersion, lag: r.lag, days_since_newer: r.daysSinceNewer,
      author: r.author ?? '',
    }))
  }
  if (kind === 'proposals') {
    return (await libraryProposalsReport(actor, q)).map(r => ({
      source_lesson: r.sourceLessonTitle, container: r.containerTitle ?? '', proposed_by: r.proposedBy, created_at: r.createdAt,
      status: r.status, decided_by: r.decidedBy ?? '', decision_comment: r.decisionComment ?? '',
    }))
  }
  return []
}

// ── library.orphan_scan ─────────────────────────────────────────────────────────────────

const SAMPLE = 50

/**
 * Следы оборванных транзакций (§11): урок с `library_module_id`, который не черновик своего
 * модуля и не урок ни одной его версии; опубликованный модуль без текущей версии; модуль без
 * тела-черновика. **Ничего не чинит** — отчёт в `audit_log` (`library.orphan_scan`) пишется
 * каждый прогон, чтобы экран показывал дату последней проверки и при нуле находок.
 */
export async function libraryOrphanScan(tenantId: string): Promise<LibraryOrphanScanReport> {
  return withTenant(tenantId, null, async (tx) => {
    const lessonsRows = await tx.execute(sql`
      select l.id, l.library_module_id, l.title
        from lessons l
       where l.library_module_id is not null
         and not exists (select 1 from library_modules m where m.draft_lesson_id = l.id)
         and not exists (select 1 from library_module_versions v where v.lesson_id = l.id)
       order by l.created_at, l.id
    `) as unknown as { id: string, library_module_id: string, title: string }[]
    const moduleRows = await tx.execute(sql`
      select m.id, m.title, case when m.draft_lesson_id is null then 'no_body' else 'no_version' end as problem
        from library_modules m
       where m.draft_lesson_id is null
          or (m.current_version_id is null and (m.status = 'published' or exists (select 1 from library_module_versions v where v.library_module_id = m.id)))
       order by m.created_at, m.id
    `) as unknown as { id: string, title: string, problem: 'no_version' | 'no_body' }[]
    const report: LibraryOrphanScanReport = {
      found: lessonsRows.length + moduleRows.length,
      lessons: lessonsRows.slice(0, SAMPLE).map(r => ({ lessonId: r.id, moduleId: r.library_module_id, title: r.title })),
      modules: moduleRows.slice(0, SAMPLE).map(r => ({ moduleId: r.id, title: r.title, problem: r.problem })),
    }
    await recordAudit(tx, { tenantId, actorId: null, action: 'library.orphan_scan', entity: 'library_module', after: report })
    return report
  })
}

// ── library.version_retire ──────────────────────────────────────────────────────────────

/** Сколько версия должна пролежать без единого закрепления, прежде чем уйти в `retired` (§11). */
export const LIBRARY_RETIRE_AFTER_DAYS = 90

/**
 * Условие «версию никто не закрепляет» (§4): не текущая версия модуля, нет активного места на
 * ней, нет урока (включая уроки опубликованных версий курса — на них идут записи) и нет узла
 * траектории, ссылающихся на неё. Отдельный SQL, чтобы им же пользовались тест и задача.
 */
function unpinnedSql(): SQL {
  return sql`
    v.status = 'published'
    and v.id is distinct from (select m.current_version_id from library_modules m where m.id = v.library_module_id)
    and not exists (select 1 from library_module_usages u where u.version_id = v.id and u.detached_at is null)
    and not exists (select 1 from lessons l where l.library_version_id = v.id)
    and not exists (select 1 from trajectory_nodes n where n.library_version_id = v.id)`
}

/**
 * С какого момента версия никем не закреплена. Истории «место ушло с версии» нет — `version_id`
 * места перезаписывается при обновлении, — поэтому берётся **самая поздняя** из дат, после
 * которых закрепление могло исчезнуть: выход следующей версии (с него она перестала быть
 * текущей и вставляться), отключение места на ней, последнее изменение любого места модуля,
 * стоящего сейчас на версии новее (обновление с этой версии — его `updated_at`). Дата выходит
 * не раньше настоящей — версия уходит в `retired` не раньше срока, иногда позже.
 */
function unpinnedSinceSql(): SQL {
  return sql`greatest(
    (select min(nv.published_at) from library_module_versions nv where nv.library_module_id = v.library_module_id and nv.version > v.version),
    (select max(u.detached_at) from library_module_usages u where u.version_id = v.id),
    (select max(u.updated_at) from library_module_usages u
       join library_module_versions uv on uv.id = u.version_id
      where u.library_module_id = v.library_module_id and uv.version > v.version)
  )`
}

async function retireTx(tx: TenantTx, tenantId: string, now: Date): Promise<LibraryVersionRetireReport> {
  const cutoff = new Date(now.getTime() - LIBRARY_RETIRE_AFTER_DAYS * DAY_MS)
  // Одна инструкция: условие проверяется в той же транзакции, что и перевод (§4)
  const rows = await tx.execute(sql`
    update library_module_versions v set status = 'retired', updated_at = ${now.toISOString()}::timestamptz
     where ${unpinnedSql()} and ${unpinnedSinceSql()} < ${cutoff.toISOString()}::timestamptz
    returning v.id, v.library_module_id, v.version,
              (select m.title from library_modules m where m.id = v.library_module_id) as module_title
  `) as unknown as { id: string, library_module_id: string, version: number, module_title: string }[]
  const report: LibraryVersionRetireReport = {
    retired: rows.length,
    versions: rows.slice(0, SAMPLE).map(r => ({ versionId: r.id, moduleId: r.library_module_id, moduleTitle: r.module_title, version: Number(r.version) })),
  }
  // Пустой прогон журнал не засоряет — задача ежедневная
  if (rows.length) await recordAudit(tx, { tenantId, actorId: null, action: 'library.version_retire', entity: 'library_module_version', after: report })
  return report
}

/**
 * `library.version_retire` (§11, ежедневно 03:40): версии, которые никто не закрепляет дольше
 * 90 дней, — в `retired`. Тело снимка остаётся (§4): закреплённое раньше продолжает читаться,
 * а обновиться до выведенной версии нельзя (`422 version_retired`).
 */
export async function libraryVersionRetire(tenantId: string, now = new Date()): Promise<LibraryVersionRetireReport> {
  return withTenant(tenantId, null, tx => retireTx(tx, tenantId, now))
}

// ── GET /library/scans ──────────────────────────────────────────────────────────────────

export async function latestLibraryScans(ctx: Ctx): Promise<LibraryScansView> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select a.action, x.after, x.created_at
        from unnest(array['library.orphan_scan', 'library.version_retire']) a(action)
        cross join lateral (
          select after, created_at from audit_log l where l.action = a.action order by l.created_at desc limit 1
        ) x`) as unknown as { action: string, after: unknown, created_at: Date | string }[]
    const pick = <T>(action: string) => {
      const r = rows.find(x => x.action === action)
      return r ? { at: new Date(r.created_at).toISOString(), report: r.after as T } : null
    }
    return {
      orphanScan: pick<LibraryOrphanScanReport>('library.orphan_scan'),
      versionRetire: pick<LibraryVersionRetireReport>('library.version_retire'),
    }
  })
}
