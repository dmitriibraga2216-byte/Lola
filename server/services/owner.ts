import { eq, sql } from 'drizzle-orm'
import { roles, userRoles, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { OWNER_ROLE_CODE } from '../../shared/domain/roles'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { employees, personById } from './repo/people'
import { logSecurity } from './securityLog'

/**
 * Владение пространством (docs/01 §1.2, §1.9.4; `docs/v2/35-billing-limits.md` §2).
 *
 * Владелец — **один человек на тенант**, и это не «ещё одна роль посильнее», а ответ на
 * вопрос «с кем у нас договор». Отсюда три правила, которые держит этот сервис:
 *
 *  1. **Ровно один.** Гарантия — в БД: частичный уникальный индекс `user_roles_single_owner_uq`
 *     по `(tenant_id) where is_owner` (миграция `0070_owner_role`). Сервис проверяет то же
 *     самое заранее, чтобы отдать понятную ошибку вместо `23505`, но последнее слово — за
 *     индексом: две одновременные передачи не разъедутся, даже если обе прошли проверку.
 *  2. **Снять с себя владение можно только передачей.** Отдельной операции «перестать быть
 *     владельцем» нет: `removeRole('owner')` и архивация владельца отказывают
 *     (`server/services/people.ts`). Иначе тенант остался бы без подписанта договора, и
 *     тариф стало бы некому менять.
 *  3. **Пока владельца нет — его может забрать администратор, один раз.** Так входят
 *     существующие тенанты: миграция заводит роль, но никому её не выдаёт (раздать владение
 *     по всей базе молча нельзя — см. шапку миграции). Первый администратор, нажавший
 *     «Стати власником», становится им; второму экран уже показывает, кто владелец.
 *
 * Тенант берётся из сессии (`ctx.tenantId`), как и везде: `withTenant` + RLS. Чужой тенант
 * не отличим от несуществующего — запрос просто ничего не находит (CLAUDE.md п. 15).
 */

export interface Ctx { tenantId: string, actorId: string }

export interface OwnerInfo {
  userId: string
  fullName: string
  email: string | null
  phone: string | null
  since: Date
}

export type OwnerError
  = 'already_owned' // владелец уже есть — «стать владельцем» больше не предлагается
    | 'no_owner' // передавать нечего: владельца ещё нет
    | 'not_owner' // передаёт не владелец (страховка поверх скоупа `tenant.transfer`)
    | 'not_found' // человека нет в этом тенанте (или он из чужого — не различаем)
    | 'same_person' // передать самому себе
    | 'not_eligible' // кандидат, архивный или заблокированный — владельцем быть не может

export type OwnerResult
  = { ok: true, owner: OwnerInfo }
    | { ok: false, code: OwnerError }

/** id роли `owner` в этом тенанте. Роль системная и заводится миграцией/созданием тенанта. */
async function ownerRoleId(tx: TenantTx): Promise<string | null> {
  const [r] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, OWNER_ROLE_CODE))
  return r?.id ?? null
}

/**
 * Кто владелец — или `null`, если владения ещё не забрали.
 * Читается по колонке `user_roles.is_owner` (её проставляет триггер из кода роли), а не по
 * коду роли в join-е: тот же признак, по которому стоит уникальный индекс, — значит, ответ
 * сервиса и гарантия БД не могут разойтись.
 */
export async function ownerIdOf(tx: TenantTx): Promise<string | null> {
  const [row] = await tx.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.isOwner, true))
  return row?.userId ?? null
}

/** Этот человек — единственный владелец тенанта? Проверка для блокировки, архивации и снятия роли. */
export async function isSoleOwner(tx: TenantTx, userId: string): Promise<boolean> {
  return (await ownerIdOf(tx)) === userId
}

async function ownerInfo(tx: TenantTx): Promise<OwnerInfo | null> {
  const [row] = await tx.select({
    userId: userRoles.userId,
    fullName: users.fullName,
    email: users.email,
    phone: users.phone,
    since: userRoles.createdAt,
  })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(eq(userRoles.isOwner, true))
  return row ?? null
}

/** Карточка «Власник простору» на экране ролей: кто владелец и можно ли забрать владение. */
export async function ownerCard(ctx: Ctx): Promise<{ owner: OwnerInfo | null, canClaim: boolean }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const owner = await ownerInfo(tx)
    return { owner, canClaim: owner === null }
  })
}

/** Человек, которому можно отдать владение: свой, сотрудник (не кандидат), действующий и не заблокированный. */
async function eligible(tx: TenantTx, userId: string): Promise<'ok' | 'not_found' | 'not_eligible'> {
  const [u] = await personById(tx, { kind: users.kind, status: users.status, isBlocked: users.isBlocked }, userId)
  if (!u) return 'not_found'
  if (u.kind !== 'employee' || u.isBlocked || (u.status !== 'active' && u.status !== 'invited')) return 'not_eligible'
  return 'ok'
}

/** Выдать роль владельца ровно одному человеку внутри уже открытой транзакции. */
async function moveOwnership(tx: TenantTx, ctx: Ctx, toUserId: string, roleId: string): Promise<void> {
  await tx.delete(userRoles).where(eq(userRoles.isOwner, true))
  await tx.insert(userRoles).values({
    tenantId: ctx.tenantId,
    userId: toUserId,
    roleId,
    scopeType: 'tenant',
    scopeId: null,
  })
}

/**
 * «Стати власником» — одноразовое действие администратора в тенанте без владельца
 * (docs/01 §1.9.4). Эндпоинт требует `settings.tenant`; здесь проверяется только то,
 * что владения ещё нет, и то, что забирающий сам годится в владельцы.
 */
export async function claimOwnership(ctx: Ctx): Promise<OwnerResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const roleId = await ownerRoleId(tx)
    if (!roleId) return { ok: false as const, code: 'not_found' as const }
    if (await ownerIdOf(tx)) return { ok: false as const, code: 'already_owned' as const }
    const check = await eligible(tx, ctx.actorId)
    if (check !== 'ok') return { ok: false as const, code: check }

    await moveOwnership(tx, ctx, ctx.actorId, roleId)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'tenant.owner_claimed',
      entity: 'tenant',
      entityId: ctx.tenantId,
      before: { ownerId: null },
      after: { ownerId: ctx.actorId },
    })
    const owner = await ownerInfo(tx)
    return owner ? { ok: true as const, owner } : { ok: false as const, code: 'not_found' as const }
  }).then(async (r) => {
    if (r.ok) await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'roles.changed', meta: { action: 'owner_claim', roleCode: OWNER_ROLE_CODE, by: ctx.actorId } })
    return r
  })
}

/**
 * «Передати володіння» — единственный способ перестать быть владельцем (docs/01 §1.9.4).
 * Скоуп `tenant.transfer` есть только у роли `owner`, но проверка «передаёт действительно
 * владелец» стоит и здесь: скоуп можно получить своей ролью тенанта, а владение — нельзя.
 */
export async function transferOwnership(ctx: Ctx, toUserId: string): Promise<OwnerResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const roleId = await ownerRoleId(tx)
    if (!roleId) return { ok: false as const, code: 'not_found' as const }
    const current = await ownerIdOf(tx)
    if (!current) return { ok: false as const, code: 'no_owner' as const }
    if (current !== ctx.actorId) return { ok: false as const, code: 'not_owner' as const }
    if (current === toUserId) return { ok: false as const, code: 'same_person' as const }
    const check = await eligible(tx, toUserId)
    if (check !== 'ok') return { ok: false as const, code: check }

    await moveOwnership(tx, ctx, toUserId, roleId)
    // Сессии бывшего владельца могли стоять на активной роли «Власник» — её больше нет.
    // Сбрасываем на роль по умолчанию, чтобы интерфейс не показывал прав, которых уже нет
    // (resolveActiveRole сам починил бы это при следующем запросе, но лучше явно).
    await tx.execute(sql`update sessions set active_role_id = null where user_id = ${current}::uuid and active_role_id = ${roleId}::uuid`)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'tenant.owner_transferred',
      entity: 'tenant',
      entityId: ctx.tenantId,
      before: { ownerId: current },
      after: { ownerId: toUserId },
    })
    await enqueueNotification(tx, {
      tenantId: ctx.tenantId,
      userId: toUserId,
      code: 'user_role_granted',
      payload: { role: 'Власник' },
      dedupKey: `owner_transfer:${toUserId}:${Date.now()}`,
    })
    const owner = await ownerInfo(tx)
    return owner ? { ok: true as const, owner } : { ok: false as const, code: 'not_found' as const }
  }).then(async (r) => {
    if (r.ok) await logSecurity({ tenantId: ctx.tenantId, userId: toUserId, event: 'roles.changed', meta: { action: 'owner_transfer', roleCode: OWNER_ROLE_CODE, by: ctx.actorId } })
    return r
  })
}

/** Кандидаты в владельцы для селекта на экране: действующие сотрудники, кроме текущего владельца. */
export async function transferCandidates(ctx: Ctx, q: string): Promise<{ id: string, fullName: string }[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const current = await ownerIdOf(tx)
    const like = `%${q.trim().toLowerCase()}%`
    // Правило 17: выборка людей — только через репозиторий, вид назван явно.
    return employees(tx, { id: users.id, fullName: users.fullName },
      eq(users.isBlocked, false),
      sql`${users.status} in ('active', 'invited')`,
      current ? sql`${users.id} <> ${current}::uuid` : undefined,
      q.trim() ? sql`lower(${users.fullName}) like ${like}` : undefined,
    )
      .orderBy(users.fullName)
      .limit(20)
  })
}
