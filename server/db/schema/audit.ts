import {
  bigserial, index, inet, jsonb, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { tenantId } from './_common'

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  tenantId: tenantId(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(), // course.publish, user.archive, attempt.grade …
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index().on(t.tenantId, t.createdAt.desc()),
])
