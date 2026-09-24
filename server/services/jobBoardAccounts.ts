import { and, desc, eq, inArray } from 'drizzle-orm'
import { jobBoardAccounts, tenantSecrets, users, vacancyPublications } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { employeeOnly } from './repo/people'
import { recordAudit } from './audit'
import { decrypt, encrypt } from './crypto'
import { adapterFor, REVOKED_STUB_SECRET } from './jobBoardAdapter'
import type { JobBoardAccountCreateInput } from '../../shared/schemas/vacancies'
import type { JobBoardAccountStatus } from '../../shared/enums'
import { enqueueNotification, tenantAdminIds } from './notifications'

/**
 * Аккаунты внешних площадок (`docs/v2/29-vacancies.md` §3.7, §7.14–§7.15, план `45` PR-17).
 *
 * Секрет живёт в `tenant_secrets`, но **не через** `secrets.ts#setSecret()`: тот разводит
 * ключи по паре `(provider, key)`, где `key` — фиксированная константа модуля (`bot_token`,
 * `refresh_token`…) и одна на тенант. Аккаунтов площадки на тенанта может быть много (компания
 * + личные + по рекрутёру, §3.7 [решение]), поэтому здесь `key = 'jobboard:<id аккаунта>'` —
 * не пересекается ни с чем, включая `SECRET_KEYS.telegram` (бот напоминаний — другая сущность,
 * другой ключ той же таблицы).
 */

export interface JobBoardCtx { tenantId: string, actorId: string, isAdmin: boolean }

export interface JobBoardAccountRow {
  id: string
  provider: string
  ownerType: string
  ownerUserId: string | null
  ownerName: string | null
  label: string | null
  status: string
  lastOkAt: Date | null
  lastError: string | null
  connectedAt: Date | null
  createdAt: Date
}

const ROW_COLUMNS = {
  id: jobBoardAccounts.id,
  provider: jobBoardAccounts.provider,
  ownerType: jobBoardAccounts.ownerType,
  ownerUserId: jobBoardAccounts.ownerUserId,
  label: jobBoardAccounts.label,
  status: jobBoardAccounts.status,
  lastOkAt: jobBoardAccounts.lastOkAt,
  lastError: jobBoardAccounts.lastError,
  connectedAt: jobBoardAccounts.connectedAt,
  createdAt: jobBoardAccounts.createdAt,
}

/**
 * Список для екрана «Інтеграції» (§5.4). Видимость: свої компанійські — усім, «Персональний»
 * — тільки свій; чужі особисті рекрутерів адміну видно всі, іншим — жодного (`[решение]`:
 * в продукті нема окремого коду ролі «HR», тож видимість звужена до адміна замість «HR і
 * адмін», задокументовано в `docs/v2/46-progress.md`, запис PR-17).
 */
export async function listAccounts(ctx: JobBoardCtx): Promise<JobBoardAccountRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({ ...ROW_COLUMNS, ownerName: users.fullName })
      .from(jobBoardAccounts)
      .leftJoin(users, eq(users.id, jobBoardAccounts.ownerUserId))
      .orderBy(jobBoardAccounts.provider, jobBoardAccounts.ownerType, desc(jobBoardAccounts.createdAt))
    if (ctx.isAdmin) return rows as JobBoardAccountRow[]
    return rows.filter(r => r.ownerType === 'company' || r.ownerUserId === ctx.actorId) as JobBoardAccountRow[]
  })
}

export type ConnectResult
  = | { ok: true, account: JobBoardAccountRow }
    | { ok: false, code: 'forbidden' | 'owner_required' | 'owner_not_employee' }

/**
 * Подключение (§7.14). Синхронное: заглушка не делает сетевого вызова, поэтому пары
 * `getAuthUrl`/`callback` из §10 здесь нет — `[решение]`, см. заголовок `jobBoardAdapter.ts`.
 */
export async function connectAccount(ctx: JobBoardCtx, input: JobBoardAccountCreateInput): Promise<ConnectResult> {
  let ownerUserId: string | null = null
  if (input.ownerType === 'company') {
    if (!ctx.isAdmin) return { ok: false, code: 'forbidden' }
  }
  else if (input.ownerType === 'personal') {
    // «Створює... тільки власник» (§7.14): чужий `ownerUserId` тут не має сенсу — це завжди «я».
    ownerUserId = ctx.actorId
  }
  else {
    // recruiter: заводить може тільки адмін (спрощення — нема окремого коду ролі «HR», §46-progress).
    if (!ctx.isAdmin) return { ok: false, code: 'forbidden' }
    if (!input.ownerUserId) return { ok: false, code: 'owner_required' }
    ownerUserId = input.ownerUserId
  }

  const account = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<JobBoardAccountRow | 'owner_not_employee'> => {
    if (ownerUserId) {
      const [person] = await tx.select({ id: users.id }).from(users).where(employeeOnly(eq(users.id, ownerUserId)))
      if (!person) return 'owner_not_employee'
    }

    const adapter = adapterFor(input.provider)
    const connected = await adapter.connect()
    if (!connected.ok) throw new Error(`jobboard connect failed: ${connected.error}`)

    const [row] = await tx.insert(jobBoardAccounts).values({
      tenantId: ctx.tenantId,
      provider: input.provider,
      ownerType: input.ownerType,
      ownerUserId,
      label: input.label ?? connected.accountLabel,
      status: 'active',
      connectedBy: ctx.actorId,
      connectedAt: new Date(),
    }).returning({ id: jobBoardAccounts.id })

    const { ciphertext, nonce } = encrypt(connected.secret)
    const [secret] = await tx.insert(tenantSecrets).values({
      tenantId: ctx.tenantId,
      provider: input.provider,
      key: `jobboard:${row!.id}`,
      valueEncrypted: ciphertext,
      nonce,
      accountLabel: connected.accountLabel,
      status: 'active',
      createdBy: ctx.actorId,
    }).returning({ id: tenantSecrets.id })

    await tx.update(jobBoardAccounts).set({ secretRef: secret!.id }).where(eq(jobBoardAccounts.id, row!.id))

    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'jobboard.account_connect',
      entity: 'job_board_account', entityId: row!.id,
      after: { provider: input.provider, ownerType: input.ownerType, ownerUserId },
    })

    const [full] = await tx.select({ ...ROW_COLUMNS, ownerName: users.fullName })
      .from(jobBoardAccounts).leftJoin(users, eq(users.id, jobBoardAccounts.ownerUserId))
      .where(eq(jobBoardAccounts.id, row!.id))
    return full as JobBoardAccountRow
  })

  if (account === 'owner_not_employee') return { ok: false, code: 'owner_not_employee' }
  return { ok: true, account }
}

export type DisconnectResult = { ok: true } | { ok: false, code: 'not_found' | 'forbidden' }

/** Отключение владельцем (§7.14). Секрет удаляется — переподключение создаст новый. */
export async function disconnectAccount(ctx: JobBoardCtx, id: string): Promise<DisconnectResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, id))
    if (!row) return { ok: false, code: 'not_found' }
    // §7.14: company — тільки адмін; personal — тільки власник (нема винятку навіть для
    // адміна: «створює, бачить статус і відключає тільки власник»); recruiter — він сам або HR/адмін.
    const allowed = row.ownerType === 'company' ? ctx.isAdmin
      : row.ownerType === 'personal' ? row.ownerUserId === ctx.actorId
        : row.ownerUserId === ctx.actorId || ctx.isAdmin
    if (!allowed) return { ok: false, code: 'forbidden' }

    if (row.secretRef) await tx.delete(tenantSecrets).where(eq(tenantSecrets.id, row.secretRef))
    await tx.update(jobBoardAccounts).set({ status: 'disabled', secretRef: null, updatedAt: new Date() }).where(eq(jobBoardAccounts.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'jobboard.account_disconnect', entity: 'job_board_account', entityId: id, before: { status: row.status } })
    return { ok: true }
  })
}

/** Секрет аккаунта (для адаптера); `null`, если аккаунт не активен или секрета нет. */
export async function accountSecret(tx: TenantTx, accountId: string): Promise<string | null> {
  const [row] = await tx.select({ secretRef: jobBoardAccounts.secretRef }).from(jobBoardAccounts).where(eq(jobBoardAccounts.id, accountId))
  if (!row?.secretRef) return null
  const [s] = await tx.select({ ciphertext: tenantSecrets.valueEncrypted, nonce: tenantSecrets.nonce }).from(tenantSecrets).where(eq(tenantSecrets.id, row.secretRef))
  if (!s) return null
  try { return decrypt(s.ciphertext, s.nonce) }
  catch { return null }
}

/**
 * Отзыв токена площадкой (§7.15, критерий §13 к. 12): аккаунт → `revoked`, секрет удалён,
 * публикации этого аккаунта → `conflict`, владелец и админ уведомлены. Вызывается фоновой
 * задачей после того, как адаптер вернул `revoked` (см. `vacancyPublications.ts`).
 */
export async function revokeAccount(tenantId: string, accountId: string): Promise<{ ownerUserId: string | null, label: string | null, provider: string } | null> {
  return withTenant(tenantId, null, async (tx) => {
    const [row] = await tx.select().from(jobBoardAccounts).where(eq(jobBoardAccounts.id, accountId))
    if (!row || row.status === 'revoked') return null
    if (row.secretRef) await tx.delete(tenantSecrets).where(eq(tenantSecrets.id, row.secretRef))
    await tx.update(jobBoardAccounts).set({ status: 'revoked' as JobBoardAccountStatus, secretRef: null, lastError: 'jobboard.revoked', updatedAt: new Date() }).where(eq(jobBoardAccounts.id, accountId))
    // Публикации этого аккаунта переживают отзыв как строки, но не как активные (§7.15):
    // «публикация не теряется» (условие выхода PR-17) — она видна в журнале со статусом `conflict`.
    await tx.update(vacancyPublications).set({ state: 'conflict', lastErrorCode: 'jobboard.account_revoked', updatedAt: new Date() })
      .where(and(eq(vacancyPublications.accountId, accountId), inArray(vacancyPublications.state, ['queued', 'publishing', 'active'])))
    await recordAudit(tx, { tenantId, actorId: null, action: 'jobboard.account_revoked', entity: 'job_board_account', entityId: accountId, before: { status: row.status } })

    const recipients = new Set<string>()
    if (row.ownerUserId) recipients.add(row.ownerUserId)
    if (row.connectedBy) recipients.add(row.connectedBy)
    for (const id of await tenantAdminIds(tx, tenantId)) recipients.add(id)
    const day = new Date().toISOString().slice(0, 10)
    for (const userId of recipients) {
      await enqueueNotification(tx, {
        tenantId, userId, code: 'vacancy_account_revoked',
        // Ключ `platform` — шаблон уже завела PR-37 (`notifications.ts` DEFAULT_TEMPLATES).
        payload: { platform: row.provider },
        // dedupKey несёт userId — иначе второй получатель в цикле молча теряет уведомление.
        dedupKey: `vacancy_account_revoked:${accountId}:${day}:${userId}`,
      }).catch(() => false)
    }
    return { ownerUserId: row.ownerUserId, label: row.label, provider: row.provider }
  })
}

/**
 * Сеанс имитации отзыва провайдером — **только для тестов**. Секрет заменяется на сигнальное
 * значение `REVOKED_STUB_SECRET`: следующий вызов `publish()`/`health()` заглушки прочитает
 * его и пойдёт по тому же коду, что и настоящий отзыв (`revokeAccount()` выше вызывается тем
 * же путём, что и в бою — фоновой задачей, не тестовым обходом).
 */
export async function simulateProviderRevocation(tenantId: string, accountId: string): Promise<void> {
  await withTenant(tenantId, null, async (tx) => {
    const [row] = await tx.select({ secretRef: jobBoardAccounts.secretRef }).from(jobBoardAccounts).where(eq(jobBoardAccounts.id, accountId))
    if (!row?.secretRef) return
    const { ciphertext, nonce } = encrypt(REVOKED_STUB_SECRET)
    await tx.update(tenantSecrets).set({ valueEncrypted: ciphertext, nonce }).where(eq(tenantSecrets.id, row.secretRef))
  })
}
