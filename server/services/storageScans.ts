import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { ensureRetentionPolicies } from '../db/tenantDefaults'
import type { StorageRetentionAnchor } from '../../shared/enums'
import { recordAudit } from './audit'
import { notifyAdmins } from './limitNotices'
import { S3_BUCKET, s3 } from './media'
import { storageQuota } from './storage'
import { retentionAnchorSql } from './storagePolicies'

/**
 * Фоновые задачи хранилища сверх корзины (`docs/v2/34-storage.md` §7.3, §7.4 п. 2, §7.5 п. 3,
 * §7.6 п. 3, §11): `storage.retention_scan`, `storage.orphan_scan`, `storage.object_reconcile`,
 * `storage.quota_warn`.
 *
 * **Три первые — всухую** (решение `docs/v2/44` §11 Р-S1): они считают, что сделали бы, и пишут
 * отчёт в `audit_log` (`storage.retention_scan` / `.orphan_scan` / `.object_reconcile`,
 * `after.dryRun = true`), но ни одной строки `media_assets` и ни одного объекта S3 не меняют.
 * Безвозвратное удаление ждёт владельца продукта (`44` §8), а каталог ссылок на файл в продукте
 * шире пяти источников §7.6 п. 3 — пометка «осиротел» по неполному каталогу позвала бы
 * администратора удалить живой файл. Экран показывает последний отчёт (`GET /storage/scans`).
 *
 * `storage.quota_warn` — настоящий: пороги 80 / 95 / 100 % поднимает `billing.limit_scan`
 * (`limit_warning` / `limit_exceeded`, В-16), здесь — только повторы по частоте §7.5 п. 3:
 * 80 % — раз в неделю, 95 % и выше — ежедневно. Коды те же, новых уведомлений нет.
 *
 * Приостановленные тенанты пропускает круг `runPerTenant` (§12: у клиента, который не может
 * возразить, retention не выполняется).
 */

/** Сколько id и ключей держит отчёт как образец — остальное только счётчиками. */
export const SCAN_SAMPLE = 50
/** Файл без ссылок старше стольких дней — кандидат в сироты (§7.6 п. 3). */
export const ORPHAN_MIN_AGE_DAYS = 7
/** Черновик сдачи с файлами старше стольких дней — мусор (§7.3). */
export const DRAFT_MAX_AGE_DAYS = 30
/** Незавершённая загрузка старше стольких часов — мусор (§7.3). */
export const STALE_UPLOAD_HOURS = 24
/** Порог «сирот больше 1 Gb» (§8 `storage_orphans_found`) — в отчёте флагом. */
export const ORPHANS_NOTICE_BYTES = 1024 ** 3

interface Totals { files: number, bytes: number }

async function writeReport(tx: TenantTx, tenantId: string, action: string, entity: string, report: object): Promise<void> {
  await recordAudit(tx, { tenantId, actorId: null, action, entity, after: { dryRun: true, ...report } })
}

// ── storage.retention_scan ──────────────────────────────────────────────────────────────

export interface RetentionPolicyScan {
  origin: string
  action: string
  keepMonths: number
  anchor: StorageRetentionAnchor
  keepEvidence: boolean
  /** Срок истёк — политика взяла бы эти файлы (всего). */
  files: number
  bytes: number
  evidenceCount: number
  /** Сколько взял бы один прогон: не больше `max_batch_per_run` (§3.3 «не снести всё разом»). */
  batchFiles: number
  /** Срок истекает в ближайшие `warn_days_before` дней — о них предупредили бы (§8 `storage_retention_warning`). */
  upcomingFiles: number
  upcomingBytes: number
}

export interface RetentionScanReport {
  dryRun: true
  policies: RetentionPolicyScan[]
  /** Черновики сдач старше 30 дней с файлами (§7.3). */
  drafts: { submissions: number } & Totals
  /** Незавершённые загрузки старше 24 часов (§7.3). */
  staleUploads: Totals
  total: Totals
}

type PolicyRow = { origin: string, keep_months: number, anchor: StorageRetentionAnchor, action: string, keep_evidence: boolean, warn_days_before: number, max_batch_per_run: number }

/**
 * Сухой прогон всех включённых удаляющих политик тенанта и двух классов мусора §7.3. Условие
 * выборки — то же, что у сухого прогона на экране (`retentionAnchorSql`, сертификат не
 * удаляется никогда, `keep_evidence` не трогает доказательства). Отчёт пишется, если есть что
 * показать: включённая политика или найденный мусор.
 */
export async function retentionScan(tenantId: string): Promise<RetentionScanReport> {
  return withTenant(tenantId, null, async (tx) => {
    await ensureRetentionPolicies(tx, tenantId)
    const rows = await tx.execute(sql`
      select origin, keep_months, anchor, action, keep_evidence, warn_days_before, max_batch_per_run
        from storage_retention_policies
       where enabled and action <> 'notify_only' and keep_months is not null
       order by origin`) as unknown as PolicyRow[]

    const policies: RetentionPolicyScan[] = []
    for (const p of rows) {
      const anchor = retentionAnchorSql(p.anchor)
      const [r] = await tx.execute(sql`
        select count(*) filter (where due)::int as files,
               coalesce(sum(bytes) filter (where due), 0)::bigint as bytes,
               count(*) filter (where due and is_evidence)::int as evidence,
               count(*) filter (where not due)::int as upcoming,
               coalesce(sum(bytes) filter (where not due), 0)::bigint as upcoming_bytes
          from (
            select m.bytes, m.is_evidence,
                   ${anchor} < now() - make_interval(months => ${p.keep_months}::int) as due
              from media_assets m
             where m.origin = ${p.origin}
               and m.lifecycle in ('active', 'orphaned')
               and m.origin <> 'certificate'
               ${p.keep_evidence ? sql`and not m.is_evidence` : sql``}
               and ${anchor} < now() - make_interval(months => ${p.keep_months}::int) + make_interval(days => ${p.warn_days_before}::int)
          ) x`) as unknown as { files: number, bytes: string, evidence: number, upcoming: number, upcoming_bytes: string }[]
      const files = r?.files ?? 0
      policies.push({
        origin: p.origin,
        action: p.action,
        keepMonths: p.keep_months,
        anchor: p.anchor,
        keepEvidence: p.keep_evidence,
        files,
        bytes: Number(r?.bytes ?? 0),
        evidenceCount: r?.evidence ?? 0,
        batchFiles: Math.min(files, p.max_batch_per_run),
        upcomingFiles: r?.upcoming ?? 0,
        upcomingBytes: Number(r?.upcoming_bytes ?? 0),
      })
    }

    // Файлы черновика: сдача не отправлена 30 дней, файлы живые. Сама сдача — не файл, её
    // удаление — та же политика, что у файлов, и тоже ждёт исполнения (§7.3).
    const [d] = await tx.execute(sql`
      select count(distinct s.id)::int as submissions, count(m.id)::int as files, coalesce(sum(m.bytes), 0)::bigint as bytes
        from workshop_submissions s
        cross join lateral jsonb_path_query(s.files, 'lax $[*].mediaId') r
        join media_assets m on m.id::text = r #>> '{}' and m.lifecycle in ('active', 'orphaned')
       where s.status = 'draft' and s.updated_at < now() - make_interval(days => ${DRAFT_MAX_AGE_DAYS})`) as unknown as { submissions: number, files: number, bytes: string }[]
    const [u] = await tx.execute(sql`
      select count(*)::int as files, coalesce(sum(bytes), 0)::bigint as bytes
        from media_assets
       where status = 'uploading' and lifecycle in ('active', 'orphaned') and source_id is null
         and created_at < now() - make_interval(hours => ${STALE_UPLOAD_HOURS})`) as unknown as { files: number, bytes: string }[]

    const drafts = { submissions: d?.submissions ?? 0, files: d?.files ?? 0, bytes: Number(d?.bytes ?? 0) }
    const staleUploads = { files: u?.files ?? 0, bytes: Number(u?.bytes ?? 0) }
    const total = {
      files: policies.reduce((n, p) => n + p.files, 0) + drafts.files + staleUploads.files,
      bytes: policies.reduce((n, p) => n + p.bytes, 0) + drafts.bytes + staleUploads.bytes,
    }
    const report: RetentionScanReport = { dryRun: true, policies, drafts, staleUploads, total }
    if (policies.length || total.files) await writeReport(tx, tenantId, 'storage.retention_scan', 'storage_retention_policies', report)
    return report
  })
}

// ── storage.orphan_scan ─────────────────────────────────────────────────────────────────

/**
 * Все места, откуда продукт ссылается на файл: id файла (uuid или текст в jsonb) или ключ объекта
 * в S3. Пять источников §7.6 п. 3 (`lessons.body` здесь — `resources`/`resource_versions`) плюс
 * всё, что знает `storage_classify_backfill()` (миграция 0083), плюс внешние ключи на
 * `media_assets` и ключи обложек, картинок и выгрузок. В jsonb ищется рекурсивно (`$.**`): блок
 * изображения лежит в теле на любой глубине. Заявки на удаление (`storage_deletion_requests`)
 * ссылкой не считаются — они не владелец файла.
 */
export const MEDIA_REFERENCE_SOURCES: { table: string, columns: string[], sql: ReturnType<typeof sql> }[] = [
  // работа людей. Люди — обоих видов явно (инвариант 17): резюме у кандидата, аватар у обоих
  { table: 'workshop_submissions', columns: ['files'], sql: sql`select r #>> '{}' from workshop_submissions x, jsonb_path_query(x.files, 'strict $.**.mediaId') r` },
  { table: 'workshop_submissions', columns: ['body'], sql: sql`select r #>> '{}' from workshop_submissions x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'checklist_runs', columns: ['answers'], sql: sql`select r #>> '{}' from checklist_runs x, jsonb_path_query(x.answers, 'strict $.**.photoMediaIds[*]') r` },
  { table: 'checklist_runs', columns: ['signature_media_id'], sql: sql`select signature_media_id::text from checklist_runs` },
  { table: 'attempt_answers', columns: ['answer'], sql: sql`select r #>> '{}' from attempt_answers x, jsonb_path_query(x.answer, 'strict $.**.mediaId') r` },
  { table: 'survey_responses', columns: ['answers'], sql: sql`select r #>> '{}' from survey_responses x, jsonb_path_query(x.answers, 'strict $.**.mediaId') r` },
  { table: 'content_reports', columns: ['screenshot_media_id'], sql: sql`select screenshot_media_id::text from content_reports` },
  { table: 'person_documents', columns: ['media_id'], sql: sql`select media_id::text from person_documents` },
  { table: 'interview_turns', columns: ['media_id'], sql: sql`select media_id::text from interview_turns` },
  { table: 'candidate_summaries', columns: ['media_id'], sql: sql`select media_id::text from candidate_summaries` },
  { table: 'vacancy_applications', columns: ['resume_asset_id'], sql: sql`select resume_asset_id::text from vacancy_applications` },
  { table: 'users', columns: ['resume_asset_id'], sql: sql`select u.resume_asset_id::text from users u where u.kind = any(array['candidate', 'employee'])` },
  { table: 'users', columns: ['avatar_key'], sql: sql`select u.avatar_key from users u where u.kind = any(array['candidate', 'employee'])` },
  { table: 'storage_pending_uploads', columns: ['media_id'], sql: sql`select media_id::text from storage_pending_uploads` },
  // контент
  { table: 'resources', columns: ['media_id'], sql: sql`select media_id::text from resources` },
  { table: 'resources', columns: ['body'], sql: sql`select r #>> '{}' from resources x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'resources', columns: ['cover_key', 'card_image_key'], sql: sql`select v from resources, unnest(array[cover_key, card_image_key]) v` },
  { table: 'resource_versions', columns: ['media_id'], sql: sql`select media_id::text from resource_versions` },
  { table: 'resource_versions', columns: ['body'], sql: sql`select r #>> '{}' from resource_versions x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'library_module_versions', columns: ['media_ids'], sql: sql`select m::text from library_module_versions, unnest(media_ids) m` },
  { table: 'questions', columns: ['stem', 'options', 'explanation'], sql: sql`select r #>> '{}' from questions x, jsonb_path_query(jsonb_build_array(x.stem, x.options, x.explanation), 'strict $.**.mediaId') r` },
  { table: 'quizzes', columns: ['description'], sql: sql`select r #>> '{}' from quizzes x, jsonb_path_query(x.description, 'strict $.**.mediaId') r` },
  { table: 'quizzes', columns: ['cover_key'], sql: sql`select cover_key from quizzes` },
  { table: 'workshops', columns: ['instruction_media'], sql: sql`select unnest(instruction_media)::text from workshops` },
  { table: 'workshops', columns: ['description'], sql: sql`select r #>> '{}' from workshops x, jsonb_path_query(x.description, 'strict $.**.mediaId') r` },
  { table: 'notices', columns: ['body', 'attachments'], sql: sql`select r #>> '{}' from notices x, jsonb_path_query(jsonb_build_array(x.body, x.attachments), 'strict $.**.mediaId') r` },
  { table: 'simple_notices', columns: ['body'], sql: sql`select r #>> '{}' from simple_notices x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'wiki_pages', columns: ['body'], sql: sql`select r #>> '{}' from wiki_pages x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'wiki_revisions', columns: ['body'], sql: sql`select r #>> '{}' from wiki_revisions x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'knowledge_articles', columns: ['body', 'attachments'], sql: sql`select r #>> '{}' from knowledge_articles x, jsonb_path_query(jsonb_build_array(x.body, x.attachments), 'strict $.**.mediaId') r` },
  { table: 'knowledge_revisions', columns: ['body'], sql: sql`select r #>> '{}' from knowledge_revisions x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'news', columns: ['body'], sql: sql`select r #>> '{}' from news x, jsonb_path_query(x.body, 'strict $.**.mediaId') r` },
  { table: 'news', columns: ['cover_key'], sql: sql`select cover_key from news` },
  { table: 'meetups', columns: ['description'], sql: sql`select r #>> '{}' from meetups x, jsonb_path_query(x.description, 'strict $.**.mediaId') r` },
  { table: 'meetups', columns: ['cover_key'], sql: sql`select cover_key from meetups` },
  { table: 'courses', columns: ['cover_key', 'icon_key'], sql: sql`select v from courses, unnest(array[cover_key, icon_key]) v` },
  { table: 'programs', columns: ['cover_key', 'icon_key'], sql: sql`select v from programs, unnest(array[cover_key, icon_key]) v` },
  { table: 'trajectories', columns: ['cover_key'], sql: sql`select cover_key from trajectories` },
  { table: 'shop_items', columns: ['image_key'], sql: sql`select image_key from shop_items` },
  { table: 'notification_templates', columns: ['image_key', 'telegram_image_key'], sql: sql`select v from notification_templates, unnest(array[image_key, telegram_image_key]) v` },
  // документы и выгрузки
  { table: 'certificates', columns: ['pdf_key'], sql: sql`select pdf_key from certificates` },
  { table: 'report_exports', columns: ['file_key'], sql: sql`select file_key from report_exports` },
  { table: 'import_jobs', columns: ['report_key'], sql: sql`select report_key from import_jobs` },
]

/** Одно множество ссылок тенанта (RLS держит выборку в своём тенанте). */
function referencesCte() {
  return sql.join(MEDIA_REFERENCE_SOURCES.map(s => sql`(${s.sql})`), sql` union `)
}

export interface OrphanScanReport {
  dryRun: true
  found: number
  bytes: number
  byOrigin: Record<string, Totals>
  /** Сирот больше 1 Gb — порог уведомления `storage_orphans_found` (§8). */
  overNoticeThreshold: boolean
  sample: string[]
}

/**
 * `storage.orphan_scan` (§7.6 п. 3): `active`-файлы старше 7 дней, на которые не ссылается ни
 * одно место из `MEDIA_REFERENCE_SOURCES`. Файл с источником (`source_id`) владельца имеет по
 * построению, загрузка в процессе — не сирота (её считает `retention_scan`), сертификат и голос
 * кандидата живут по своим правилам. Всухую: `lifecycle` не меняется.
 */
export async function orphanScan(tenantId: string): Promise<OrphanScanReport> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      with refs(ref) as materialized (select distinct ref from (${referencesCte()}) u(ref) where ref is not null)
      select m.id, m.origin, m.bytes
        from media_assets m
       where m.lifecycle = 'active'
         and m.status <> 'uploading'
         and m.source_id is null
         and m.origin not in ('certificate', 'interview_answer')
         and m.created_at < now() - make_interval(days => ${ORPHAN_MIN_AGE_DAYS})
         and not exists (select 1 from refs r where r.ref = m.id::text)
         and not exists (select 1 from refs r where r.ref = m.key)
       order by m.created_at, m.id`) as unknown as { id: string, origin: string, bytes: number }[]

    const byOrigin: Record<string, Totals> = {}
    let bytes = 0
    for (const r of rows) {
      const o = (byOrigin[r.origin] ??= { files: 0, bytes: 0 })
      o.files++
      o.bytes += Number(r.bytes)
      bytes += Number(r.bytes)
    }
    const report: OrphanScanReport = {
      dryRun: true,
      found: rows.length,
      bytes,
      byOrigin,
      overNoticeThreshold: bytes > ORPHANS_NOTICE_BYTES,
      sample: rows.slice(0, SCAN_SAMPLE).map(r => r.id),
    }
    if (report.found) await writeReport(tx, tenantId, 'storage.orphan_scan', 'media_assets', report)
    return report
  })
}

// ── storage.object_reconcile ────────────────────────────────────────────────────────────

export interface ListedObject { key: string, bytes: number }
export type ObjectLister = (prefix: string) => Promise<ListedObject[]>

const s3Lister: ObjectLister = async (prefix) => {
  const out: ListedObject[] = []
  let token: string | undefined
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: S3_BUCKET(), Prefix: prefix, ContinuationToken: token }))
    for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, bytes: Number(o.Size ?? 0) })
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return out
}

let lister: ObjectLister = s3Lister

/** Подмена листинга бакета в тестах (без MinIO, отказ S3); `null` — настоящий S3. */
export function setStorageObjectLister(fn: ObjectLister | null): void {
  lister = fn ?? s3Lister
}

export interface ObjectReconcileReport {
  dryRun: true
  objects: Totals
  /** Объект без строки и без ссылки — по §7.4 п. 2 стал бы строкой `other`/`orphaned`. */
  unregistered: Totals & { sample: string[] }
  /** Строка без объекта — по §7.4 п. 2 стала бы `purged`. */
  missing: Totals & { sample: string[] }
  /** Строка уже `purged`, объект на месте — список к физическому удалению (`44` §8). */
  purgedAwaiting: Totals
}

/**
 * `storage.object_reconcile` (§7.4 п. 2, ежемесячно): листинг префикса `t/<tenant_id>/` против
 * реестра. Ключами реестра считаются сам файл, обложка и варианты обработки строки
 * `media_assets`, а также ключи из `MEDIA_REFERENCE_SOURCES` (аватар, PDF сертификата,
 * выгрузки) — эти объекты законны, хотя строки у них нет. Строкой без объекта считается файл
 * старше суток, чья загрузка завершена: иначе листинг поймал бы загрузку в полёте.
 * Всухую: ни строк, ни объектов не меняет; ошибка листинга — исключение и повтор задачи.
 */
export async function objectReconcile(tenantId: string): Promise<ObjectReconcileReport> {
  const listed = await lister(`t/${tenantId}/`)
  const inBucket = new Map(listed.map(o => [o.key, o.bytes]))

  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select id, key, poster_key, variants, lifecycle, status, bytes, created_at < now() - interval '1 day' as settled
        from media_assets`) as unknown as { id: string, key: string, poster_key: string | null, variants: unknown, lifecycle: string, status: string, bytes: number, settled: boolean }[]
    const refs = await tx.execute(sql`select distinct ref from (${referencesCte()}) u(ref) where ref like 't/%'`) as unknown as { ref: string }[]

    const known = new Set<string>(refs.map(r => r.ref))
    const purgedKeys = new Set<string>()
    const missing: ObjectReconcileReport['missing'] = { files: 0, bytes: 0, sample: [] }
    for (const r of rows) {
      const variants = r.variants && typeof r.variants === 'object' ? Object.values(r.variants as Record<string, unknown>).filter((v): v is string => typeof v === 'string') : []
      for (const k of [r.key, r.poster_key, ...variants]) if (k) known.add(k)
      if (r.lifecycle === 'purged') {
        purgedKeys.add(r.key)
        continue
      }
      if (r.settled && r.status !== 'uploading' && !inBucket.has(r.key)) {
        missing.files++
        missing.bytes += Number(r.bytes)
        if (missing.sample.length < SCAN_SAMPLE) missing.sample.push(r.id)
      }
    }

    const unregistered: ObjectReconcileReport['unregistered'] = { files: 0, bytes: 0, sample: [] }
    const purgedAwaiting: Totals = { files: 0, bytes: 0 }
    let totalBytes = 0
    for (const o of listed) {
      totalBytes += o.bytes
      if (purgedKeys.has(o.key)) {
        purgedAwaiting.files++
        purgedAwaiting.bytes += o.bytes
      }
      else if (!known.has(o.key)) {
        unregistered.files++
        unregistered.bytes += o.bytes
        if (unregistered.sample.length < SCAN_SAMPLE) unregistered.sample.push(o.key)
      }
    }

    const report: ObjectReconcileReport = {
      dryRun: true,
      objects: { files: listed.length, bytes: totalBytes },
      unregistered,
      missing,
      purgedAwaiting,
    }
    if (listed.length || rows.length) await writeReport(tx, tenantId, 'storage.object_reconcile', 'media_assets', report)
    return report
  })
}

// ── storage.quota_warn ──────────────────────────────────────────────────────────────────

export type QuotaWarnLevel = 'none' | 'weekly' | 'daily' | 'exceeded'

/** Частота напоминания по заполненности (§7.5 п. 3): 80 % — неделя, 95 % — сутки, 100 % — сутки. */
export function quotaWarnLevel(pct: number | null): QuotaWarnLevel {
  if (pct == null || pct < 80) return 'none'
  if (pct >= 100) return 'exceeded'
  return pct >= 95 ? 'daily' : 'weekly'
}

/**
 * `storage.quota_warn` (08:00 ежедневно): напоминание администраторам тем же уведомлением, что
 * поднимает `billing.limit_scan`. Неделя «тишины» для 80 % считается от последнего такого
 * уведомления человеку, в том числе от подъёма уровня; при 95 % и выше — не чаще раза в сутки
 * (ключ дедупликации суточный и общий с подъёмом: в день подъёма второго письма нет).
 */
export async function quotaWarn(tenantId: string): Promise<{ level: QuotaWarnLevel, pct: number | null, sent: number }> {
  const q = await storageQuota(tenantId)
  const level = quotaWarnLevel(q.pct)
  if (level === 'none' || q.limitBytes == null) return { level, pct: q.pct, sent: 0 }
  const sent = await notifyAdmins(
    tenantId, 'storage_bytes', level === 'exceeded' ? 'exceeded' : 'warn', q.usedBytes, q.limitBytes,
    { reminder: true, quietDays: level === 'weekly' ? 7 : undefined },
  )
  return { level, pct: q.pct, sent }
}

// ── Последние отчёты для экрана ─────────────────────────────────────────────────────────

export interface StorageScansView {
  retention: { at: string, report: RetentionScanReport } | null
  orphans: { at: string, report: OrphanScanReport } | null
  objects: { at: string, report: ObjectReconcileReport } | null
}

/** `GET /storage/scans`: последний отчёт каждой сухой задачи (`audit_log`, свой тенант). */
export async function latestScans(ctx: { tenantId: string, actorId: string }): Promise<StorageScansView> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select a.action, x.after, x.created_at
        from unnest(array['storage.retention_scan', 'storage.orphan_scan', 'storage.object_reconcile']) a(action)
        cross join lateral (
          select after, created_at from audit_log l where l.action = a.action order by l.created_at desc limit 1
        ) x`) as unknown as { action: string, after: unknown, created_at: Date | string }[]
    const pick = <T>(action: string) => {
      const r = rows.find(x => x.action === action)
      return r ? { at: new Date(r.created_at).toISOString(), report: r.after as T } : null
    }
    return {
      retention: pick<RetentionScanReport>('storage.retention_scan'),
      orphans: pick<OrphanScanReport>('storage.orphan_scan'),
      objects: pick<ObjectReconcileReport>('storage.object_reconcile'),
    }
  })
}
