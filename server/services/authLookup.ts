import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/**
 * Предаутентификационные выборки через SECURITY DEFINER функции
 * (миграция 0003): единственные «двери» сквозь RLS до выбора тенанта.
 */

export interface PhoneUser {
  user_id: string
  tenant_id: string
  tenant_slug: string
  tenant_name: string
  full_name: string
  status: string
  locale: string
  has_telegram: boolean
}

export async function usersByPhone(phone: string): Promise<PhoneUser[]> {
  const rows = await db.execute(sql`select * from auth_users_by_phone(${phone})`)
  return rows as unknown as PhoneUser[]
}

export interface SessionRow {
  session_id: string
  tenant_id: string
  user_id: string
  expires_at: string
  revoked_at: string | null
  impersonated_by: string | null
  active_role_id: string | null
  impersonator_admin_id: string | null
}

export async function sessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
  const rows = await db.execute(sql`select * from auth_session_by_token(${tokenHash})`)
  const list = rows as unknown as SessionRow[]
  return list[0] ?? null
}

export interface InvitationRow {
  invitation_id: string
  tenant_id: string
  user_id: string
  expires_at: string
  accepted_at: string | null
}

export async function invitationByTokenHash(tokenHash: string): Promise<InvitationRow | null> {
  const rows = await db.execute(sql`select * from auth_invitation_by_token(${tokenHash})`)
  const list = rows as unknown as InvitationRow[]
  return list[0] ?? null
}
