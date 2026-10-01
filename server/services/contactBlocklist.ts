import { createHmac } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { contactBlocklist, vacancies, vacancyApplications } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { phoneSchema } from '../../shared/schemas/auth'
import type { BlocklistCreateInput } from '../../shared/schemas/vacancies'
import { recordAudit } from './audit'
import { maskEmail, maskPhone } from './candidates'

/**
 * Чёрный список контактов тенанта (`docs/v2/29-vacancies.md` §7.7, слагаемое 100; миграция
 * 0104; решение `v2/44` Р-VT.4).
 *
 * Список нужен ровно для одного вопроса публичной формы: «этот телефон или почту компания уже
 * отказалась видеть?». Поэтому хранится не контакт, а его HMAC с посолью тенанта (тот же приём,
 * что `ip_hash`, §3.9) и маска для экрана: вернуть номер из списка нельзя, сличить — можно, а
 * два тенанта не могут сличить свои списки между собой. Совпадение ставит отклик сразу в
 * `spam` (100 = порог немого отсева §7.7) — без уведомления, как у любого спама.
 *
 * Вид контакта отдельно не хранится: `@` отличает почту от телефона и при нормализации, и в
 * маске, — нового перечисления список не заводит (CLAUDE.md п. 13).
 */

function secret(): string {
  // Без ключа подпись подделывает любой — отказ, а не общеизвестная строка (security-sweep-1)
  const key = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY
  if (!key) throw new Error('SESSION_SECRET не задан')
  return key
}

/** Нормализация: почта — нижний регистр без пробелов; телефон — `+380XXXXXXXXX` (как вход и форма). */
export function normalizeContact(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  if (v.includes('@')) {
    const email = v.toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 ? email : null
  }
  const p = phoneSchema.safeParse(v)
  return p.success ? p.data : null
}

export function contactHash(tenantId: string, normalized: string): string {
  return createHmac('sha256', `${secret()}:${tenantId}:blocklist`).update(normalized).digest('hex')
}

export function maskContact(normalized: string): string {
  return (normalized.includes('@') ? maskEmail(normalized) : maskPhone(normalized)) ?? '***'
}

/** Есть ли телефон или почта отклика в списке — вызывается из приёма отклика (`publicApply.ts`). */
export async function isContactBlocked(tx: TenantTx, tenantId: string, contacts: (string | null | undefined)[]): Promise<boolean> {
  const hashes = contacts
    .map(c => (c ? normalizeContact(c) : null))
    .filter((c): c is string => !!c)
    .map(c => contactHash(tenantId, c))
  if (!hashes.length) return false
  const rows = await tx.select({ id: contactBlocklist.id }).from(contactBlocklist)
    .where(inArray(contactBlocklist.contactHash, hashes)).limit(1)
  return rows.length > 0
}

export interface Ctx { tenantId: string, actorId: string }

export interface BlocklistRow {
  id: string
  contactMasked: string
  reason: string | null
  createdByName: string | null
  createdAt: Date
}

const ROW = {
  id: contactBlocklist.id,
  contactMasked: contactBlocklist.contactMasked,
  reason: contactBlocklist.reason,
  // ФИО добавившего — подзапросом по первичному ключу: вид человека здесь не важен (В-8).
  createdByName: sql<string | null>`(select u2.full_name from users u2 where u2.id = ${contactBlocklist.createdBy})`,
  createdAt: contactBlocklist.createdAt,
}

export async function listBlocklist(ctx: Ctx): Promise<BlocklistRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.select(ROW).from(contactBlocklist)
    .orderBy(desc(contactBlocklist.createdAt)).limit(500))
}

export type AddResult =
  | { ok: true, items: BlocklistRow[] }
  | { ok: false, code: 'invalid_contact' | 'duplicate' | 'not_found' }

/** Строка(и) списка в одной транзакции; повтор того же контакта — `duplicate`, строка одна. */
async function insertContacts(tx: TenantTx, ctx: Ctx, contacts: string[], reason: string | null, source: Record<string, unknown>): Promise<BlocklistRow[]> {
  const added: BlocklistRow[] = []
  for (const normalized of contacts) {
    const [row] = await tx.insert(contactBlocklist).values({
      tenantId: ctx.tenantId,
      contactHash: contactHash(ctx.tenantId, normalized),
      contactMasked: maskContact(normalized),
      reason,
      createdBy: ctx.actorId,
    }).onConflictDoNothing().returning({ id: contactBlocklist.id })
    if (!row) continue
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'contact_blocklist.add', entity: 'contact_blocklist', entityId: row.id,
      after: { contact: maskContact(normalized), reason, ...source },
    })
    const [full] = await tx.select(ROW).from(contactBlocklist).where(eq(contactBlocklist.id, row.id))
    added.push(full!)
  }
  return added
}

/** «Додати контакт» на вкладке «Чорний список» (`POST /contact-blocklist`). */
export async function addToBlocklist(ctx: Ctx, input: BlocklistCreateInput): Promise<AddResult> {
  const normalized = normalizeContact(input.contact)
  if (!normalized) return { ok: false, code: 'invalid_contact' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const items = await insertContacts(tx, ctx, [normalized], input.reason ?? null, { source: 'manual' })
    return items.length ? { ok: true, items } : { ok: false, code: 'duplicate' }
  })
}

/**
 * «До чорного списку» из строки отклика (`POST /vacancies/:id/applications/:aid/blocklist`):
 * оба контакта отклика разом. Состояние отклика не меняется — «Позначити спамом» отдельная
 * кнопка: список про будущие отклики, а решение по этому принимает человек.
 */
export async function blocklistApplication(ctx: Ctx, vacancyId: string, applicationId: string, reason: string | null): Promise<AddResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [vac] = await tx.select({ id: vacancies.id }).from(vacancies).where(eq(vacancies.id, vacancyId))
    if (!vac) return { ok: false, code: 'not_found' }
    const [app] = await tx.select({ phone: vacancyApplications.phone, email: vacancyApplications.email }).from(vacancyApplications)
      .where(and(eq(vacancyApplications.id, applicationId), eq(vacancyApplications.vacancyId, vacancyId)))
    if (!app) return { ok: false, code: 'not_found' }
    const contacts = [app.phone, app.email].map(c => (c ? normalizeContact(c) : null)).filter((c): c is string => !!c)
    if (!contacts.length) return { ok: false, code: 'invalid_contact' }
    const items = await insertContacts(tx, ctx, contacts, reason, { source: 'application', applicationId })
    return items.length ? { ok: true, items } : { ok: false, code: 'duplicate' }
  })
}

export async function removeFromBlocklist(ctx: Ctx, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.delete(contactBlocklist).where(eq(contactBlocklist.id, id))
      .returning({ id: contactBlocklist.id, contactMasked: contactBlocklist.contactMasked })
    if (!row) return false
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'contact_blocklist.remove', entity: 'contact_blocklist', entityId: id,
      before: { contact: row.contactMasked },
    })
    return true
  })
}
