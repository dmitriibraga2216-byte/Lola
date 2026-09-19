import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'

interface Ctx { tenantId: string, actorId: string }
type Row = Record<string, unknown>

/**
 * Журналы (docs/22 §5): единый вход `/logs/:kind` с фильтрами по периоду, человеку, типу события;
 * сроки хранения и ежедневная очистка `logs.retention`. Записи неизменяемы — только чтение и удаление по сроку.
 */
export const LOG_KINDS = ['status', 'notifications', 'sessions', 'security', 'import', 'automation', 'integrations'] as const
export type LogKind = typeof LOG_KINDS[number]

/** Сроки хранения, дней (docs/22 §5). */
export const RETENTION_DAYS: Record<LogKind, number> = { status: 3 * 365, notifications: 365, sessions: 365, security: 3 * 365, import: 3 * 365, automation: 365, integrations: 90 }

export interface LogFilter { from?: string, to?: string, userId?: string, type?: string, limit?: number, cursor?: string }

export async function readLog(ctx: Ctx, kind: LogKind, f: LogFilter = {}): Promise<Row[]> {
  const limit = Math.min(500, f.limit ?? 100)
  const period = (col: ReturnType<typeof sql>) => sql`${f.from ? sql`and ${col} >= ${f.from}::date` : sql``} ${f.to ? sql`and ${col} < (${f.to}::date + 1)` : sql``}`
  const cursor = (col: ReturnType<typeof sql>) => f.cursor ? sql`and ${col} < ${f.cursor}::timestamptz` : sql``
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    switch (kind) {
      case 'status':
        // Протокол изменений статусов: аудит с before.status → after.status
        return tx.execute(sql`
          select a.id, a.created_at, a.action, a.entity, a.entity_id, a.before->>'status' as from_status, a.after->>'status' as to_status, u.full_name as actor
          from audit_log a left join users u on u.id = a.actor_id
          where (a.before ? 'status' or a.after ? 'status') ${period(sql`a.created_at`)} ${cursor(sql`a.created_at`)}
            ${f.userId ? sql`and (a.actor_id = ${f.userId}::uuid or a.entity_id = ${f.userId}::uuid)` : sql``} ${f.type ? sql`and a.action like ${`${f.type}%`}` : sql``}
          order by a.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'notifications':
        return tx.execute(sql`
          select n.id, n.created_at, n.code, n.channel, n.status, n.error, n.rendered_text, n.sent_at, n.scheduled_for, u.full_name as recipient, n.user_id
          from notifications n join users u on u.id = n.user_id
          where true ${period(sql`n.created_at`)} ${cursor(sql`n.created_at`)} ${f.userId ? sql`and n.user_id = ${f.userId}::uuid` : sql``} ${f.type ? sql`and n.code = ${f.type}` : sql``}
          order by n.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'sessions':
        return tx.execute(sql`
          select s.id, s.created_at, s.user_agent, s.ip, s.expires_at, s.revoked_at, s.updated_at as last_active, s.impersonated_by, u.full_name, s.user_id
          from sessions s join users u on u.id = s.user_id
          where true ${period(sql`s.created_at`)} ${cursor(sql`s.created_at`)} ${f.userId ? sql`and s.user_id = ${f.userId}::uuid` : sql``}
          order by s.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'security':
        return tx.execute(sql`
          select s.id, s.created_at, s.event, s.ip, s.user_agent, s.meta, u.full_name, s.user_id
          from security_log s left join users u on u.id = s.user_id
          where true ${period(sql`s.created_at`)} ${cursor(sql`s.created_at`)} ${f.userId ? sql`and s.user_id = ${f.userId}::uuid` : sql``} ${f.type ? sql`and s.event like ${`${f.type}%`}` : sql``}
          order by s.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'import':
        return tx.execute(sql`
          select j.id, j.created_at, j.file_name, j.source, j.status, j.stats, j.finished_at, u.full_name as created_by_name
          from import_jobs j left join users u on u.id = j.created_by
          where true ${period(sql`j.created_at`)} ${cursor(sql`j.created_at`)} ${f.userId ? sql`and j.created_by = ${f.userId}::uuid` : sql``}
          order by j.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'automation':
        return tx.execute(sql`
          select r.id, r.created_at, r.status, r.error, r.actions_result, r.trigger_payload, ar.name as rule, u.full_name, r.user_id
          from automation_runs r join automation_rules ar on ar.id = r.rule_id left join users u on u.id = r.user_id
          where true ${period(sql`r.created_at`)} ${cursor(sql`r.created_at`)} ${f.userId ? sql`and r.user_id = ${f.userId}::uuid` : sql``} ${f.type ? sql`and r.status = ${f.type}` : sql``}
          order by r.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
      case 'integrations':
        return tx.execute(sql`
          select d.id, d.created_at, d.event, d.status, d.status_code, d.attempt, d.payload, d.response_body, d.delivered_at, w.url
          from webhook_deliveries d left join webhook_endpoints w on w.id = d.endpoint_id
          where true ${period(sql`d.created_at`)} ${cursor(sql`d.created_at`)} ${f.type ? sql`and d.event = ${f.type}` : sql``}
          order by d.created_at desc limit ${limit}`) as unknown as Promise<Row[]>
    }
  })
}

/** Ежедневно `logs.retention`: удаление записей старше срока хранения. Аудит статусов хранится в audit_log — 3 года. */
export async function retentionScan(tenantId: string): Promise<Record<string, number>> {
  return withTenant(tenantId, null, async (tx) => {
    const out: Record<string, number> = {}
    const del = async (name: string, query: ReturnType<typeof sql>) => { const rows = await tx.execute(query) as unknown as unknown[]; out[name] = rows.length }
    await del('audit', sql`delete from audit_log where created_at < now() - (${RETENTION_DAYS.status} || ' days')::interval returning id`)
    await del('notifications', sql`delete from notifications where created_at < now() - (${RETENTION_DAYS.notifications} || ' days')::interval returning id`)
    await del('sessions', sql`delete from sessions where created_at < now() - (${RETENTION_DAYS.sessions} || ' days')::interval returning id`)
    await del('security', sql`delete from security_log where created_at < now() - (${RETENTION_DAYS.security} || ' days')::interval returning id`)
    await del('import', sql`delete from import_jobs where created_at < now() - (${RETENTION_DAYS.import} || ' days')::interval returning id`)
    await del('automation', sql`delete from automation_runs where created_at < now() - (${RETENTION_DAYS.automation} || ' days')::interval returning id`)
    await del('integrations', sql`delete from webhook_deliveries where created_at < now() - (${RETENTION_DAYS.integrations} || ' days')::interval returning id`)
    await del('search', sql`delete from search_queries where created_at < now() - interval '365 days' returning id`)
    return out
  })
}
