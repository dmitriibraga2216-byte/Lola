import { sql } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'

/**
 * Справочники по умолчанию для нового тенанта. Вызывается из сида и createTenant
 * (в миграции их вставлять нельзя — на чистой БД тенантов ещё нет).
 * Идемпотентно: ON CONFLICT DO NOTHING по (tenant_id, code|name).
 */
export const DEFAULT_GOAL_STATUSES = [
  { code: 'planned', name: 'Заплановано', color: 'muted', sort: 0, isInitial: true, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['in_progress', 'cancelled'], who: ['development.own', 'development.team'] },
  { code: 'in_progress', name: 'В роботі', color: 'sun', sort: 1, isInitial: false, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['on_review', 'cancelled'], who: ['development.own', 'development.team'] },
  { code: 'on_review', name: 'На перевірці', color: 'sun', sort: 2, isInitial: false, isFinal: false, isSuccess: false, requiresComment: false, transitions: ['achieved', 'not_achieved', 'in_progress'], who: ['development.own'] },
  { code: 'achieved', name: 'Досягнуто', color: 'teal', sort: 3, isInitial: false, isFinal: true, isSuccess: true, requiresComment: false, transitions: [], who: ['development.team'] },
  { code: 'not_achieved', name: 'Не досягнуто', color: 'coral', sort: 4, isInitial: false, isFinal: true, isSuccess: false, requiresComment: true, transitions: ['in_progress'], who: ['development.team'] },
  { code: 'cancelled', name: 'Скасовано', color: 'muted', sort: 5, isInitial: false, isFinal: true, isSuccess: false, requiresComment: true, transitions: [], who: ['development.own', 'development.team'] },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureTenantDefaults(tx: PgTransaction<any, any, any>, tenantId: string): Promise<void> {
  const arr = (xs: string[]) => xs.length ? sql`ARRAY[${sql.join(xs.map(x => sql`${x}`), sql`, `)}]::text[]` : sql`'{}'::text[]`
  for (const s of DEFAULT_GOAL_STATUSES) {
    await tx.execute(sql`
      insert into goal_statuses (tenant_id, code, name, color, sort, is_initial, is_final, is_success, requires_comment, allowed_transitions, who_can_set)
      values (${tenantId}::uuid, ${s.code}, ${s.name}, ${s.color}, ${s.sort}, ${s.isInitial}, ${s.isFinal}, ${s.isSuccess}, ${s.requiresComment}, ${arr(s.transitions)}, ${arr(s.who)})
      on conflict (tenant_id, code) do nothing`)
  }
}
