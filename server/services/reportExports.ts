import { PutObjectCommand } from '@aws-sdk/client-s3'
import { and, desc, eq, sql } from 'drizzle-orm'
import { reportExports, savedReports } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { S3_BUCKET, ensureBucket, s3, signedReadUrl } from './media'
import { enqueueNotification } from './notifications'
import { recordAudit } from './audit'
import { toXlsx } from './reports'
import { reportScope, loadAccess, narrowScope } from './access'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>

/**
 * Фоновые выгрузки (docs/22 §7.3, §13.3): задача `report.export` строит xlsx/csv, кладёт в S3,
 * ссылка приходит уведомлением `report_export_ready` и живёт 24 часа. Область видимости — как у экрана.
 * Факт выгрузки с телефонами пишется в журнал безопасности (§11) через audit_log.
 */

export const EXPORT_TTL_HOURS = 24

export async function requestExport(ctx: Ctx, input: { report: string, filters?: Record<string, unknown>, format?: 'xlsx' | 'csv' }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.insert(reportExports).values({ tenantId: ctx.tenantId, userId: ctx.actorId, report: input.report, filters: input.filters ?? {}, format: input.format ?? 'xlsx' }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'report.export', entity: 'report_export', entityId: e!.id, after: { report: input.report, filters: input.filters ?? {} } })
    return e!
  })
}

export async function getExport(ctx: Ctx, id: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [e] = await tx.select().from(reportExports).where(and(eq(reportExports.id, id), eq(reportExports.userId, ctx.actorId)))
    if (!e) return null
    const expired = e.expiresAt ? e.expiresAt.getTime() < Date.now() : false
    return { ...e, url: e.status === 'ready' && e.fileKey && !expired ? await signedReadUrl(e.fileKey) : null, expired }
  })
}

export async function myExports(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ id: reportExports.id, report: reportExports.report, status: reportExports.status, rows: reportExports.rows, createdAt: reportExports.createdAt, expiresAt: reportExports.expiresAt, format: reportExports.format })
    .from(reportExports).where(eq(reportExports.userId, ctx.actorId)).orderBy(desc(reportExports.createdAt)).limit(20))
}

/** Строки любого отчёта по имени и фильтрам — с областью видимости заказчика выгрузки. */
export async function reportRows(tenantId: string, userId: string, report: string, filters: Record<string, unknown>): Promise<Row[]> {
  const access = await loadAccess({ sessionId: 'export', tenantId, userId, impersonatedBy: null } as never)
  if (!access) return []
  const ctx = { tenantId, actorId: userId }
  const scope = narrowScope(await reportScope(access), filters.locationId as string | undefined)
  const f = { ...filters, scope } as never
  if (report.startsWith('saved:')) {
    const { runReport } = await import('./reportBuilder')
    const [r] = await withTenant(tenantId, userId, tx => tx.select().from(savedReports).where(eq(savedReports.id, report.slice(6))))
    if (!r) return []
    return runReport(ctx, { entity: r.entity as never, fields: r.fields, filters: r.filters as Record<string, unknown>, groupBy: r.groupBy }, 100_000, scope)
  }
  const R = await import('./reports')
  const X = await import('./reportsExtra')
  switch (report) {
    case 'readiness': return R.readiness(ctx, f)
    case 'overdue': return R.overdue(ctx, f)
    case 'attempts': return R.attemptsReport(ctx, f)
    case 'mentors': return R.mentors(ctx, f)
    case 'activity': return (await R.activity(ctx, f)).daily
    case 'progress': return (await X.progress(ctx, f)).rows
    case 'content': return (await X.content(ctx, f)).rows
    case 'questions': return X.failedQuestions(ctx, f)
    default: return []
  }
}

export function toCsv(rows: Row[]): Buffer {
  if (!rows.length) return Buffer.from('')
  const cols = Object.keys(rows[0]!)
  const esc = (v: unknown) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return Buffer.from(`\uFEFF${[cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\n')}`, 'utf-8')
}

/** Задача report.export: построить файл, положить в S3, уведомить. */
export async function runExport(exportId: string, tenantId: string): Promise<void> {
  const [e] = await withTenant(tenantId, null, tx => tx.update(reportExports).set({ status: 'running', updatedAt: new Date() }).where(and(eq(reportExports.id, exportId), eq(reportExports.status, 'queued'))).returning())
  if (!e) return
  try {
    const rows = await reportRows(tenantId, e.userId, e.report, e.filters as Record<string, unknown>)
    const buffer = e.format === 'csv' ? toCsv(rows) : await toXlsx(e.report, rows as never)
    const key = `exports/${tenantId}/${exportId}.${e.format}`
    await ensureBucket()
    await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: buffer, ContentType: e.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000)
    await withTenant(tenantId, null, async (tx) => {
      await tx.update(reportExports).set({ status: 'ready', rows: rows.length, fileKey: key, expiresAt, finishedAt: new Date(), updatedAt: new Date() }).where(eq(reportExports.id, exportId))
      await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'report_export_ready', payload: { report: e.report, rows: rows.length, url: `${process.env.APP_URL ?? ''}/admin/reports/exports/${exportId}` }, dedupKey: `export:${exportId}` })
    })
  }
  catch (err) {
    await withTenant(tenantId, null, async (tx) => {
      await tx.update(reportExports).set({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500), finishedAt: new Date(), updatedAt: new Date() }).where(eq(reportExports.id, exportId))
      await enqueueNotification(tx, { tenantId, userId: e.userId, code: 'report_export_failed', payload: { report: e.report }, dedupKey: `export_failed:${exportId}` })
    })
    throw err
  }
}

/** Ежедневно: файлы старше срока — убираем ссылку (объект в S3 остаётся до lifecycle-политики бакета). */
export async function expireExports(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.update(reportExports).set({ fileKey: null, updatedAt: new Date() }).where(and(eq(reportExports.status, 'ready'), sql`${reportExports.expiresAt} < now()`, sql`${reportExports.fileKey} is not null`)).returning({ id: reportExports.id })
    return rows.length
  })
}
