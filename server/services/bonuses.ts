import { sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { PointsCurrency, PointsEvent } from '../../shared/enums'
import type { BalancesFilter, BonusAdjustInput, LedgerFilter } from '../../shared/schemas/gamification'
import type { Access } from './access'
import { areaForScope, can, scopeSql } from './access'
import { recordAudit } from './audit'
import { balanceOf, postEntry } from './pointsLedger'
import { EMPLOYEE, personById } from './repo/people'
import { frameJoins, frameSelect, frameWhere, periodSql } from './reportFrame'
import { enqueueNotification } from './notifications'

/**
 * Бонуси: кабинет человека, «Журнал операцій з бонусами» и «Керування бонусами» (docs/21 §14.9,
 * мокап Bonuses), ручное начисление (docs/04 `POST /bonuses/adjust`).
 *
 * Видимость журнала и реестра: `shop.manage` — вся сеть; `bonus.grant` — люди своей области
 * (наставник и руководитель точки начисляют «своим», docs/21 §2). Человек в строке — единый
 * каркас отчётов (`reportFrame`): ПІБ · посада · місто · підрозділ · мітки; только сотрудники.
 */

export interface Ctx { tenantId: string, actorId: string }

export interface LedgerRow {
  id: number
  currency: PointsCurrency
  delta: number
  balanceAfter: number
  event: PointsEvent
  title: string | null
  comment: string | null
  createdAt: string
}

const ledgerRow = (r: Record<string, unknown>): LedgerRow => ({
  id: Number(r.id),
  currency: r.currency as PointsCurrency,
  delta: Number(r.delta),
  balanceAfter: Number(r.balance_after),
  event: r.event as PointsEvent,
  title: (r.title as string | null) ?? null,
  comment: (r.comment as string | null) ?? null,
  createdAt: new Date(r.created_at as string).toISOString(),
})

/**
 * `GET /me/bonuses` (docs/04 §4.4): баланс бонусов, рейтинг, книга операций человека и «Вистачить
 * на «…»» из мокапа Profile — самый дорогой доступный сейчас подарок в пределах баланса.
 */
export async function myBonuses(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const balance = await balanceOf(tx, ctx.actorId, 'bonuses')
    const rating = await balanceOf(tx, ctx.actorId, 'points')
    const rows = await tx.execute(sql`
      select id, currency, delta, balance_after, event, title, comment, created_at from points_ledger
      where user_id = ${ctx.actorId}::uuid and currency = 'bonuses' order by id desc limit 100
    `) as unknown as Record<string, unknown>[]
    const [affordable] = await tx.execute(sql`
      select id, title, price_bonuses from shop_items
      where is_active and deleted_at is null and (stock is null or stock > 0) and price_bonuses <= ${balance}
      order by price_bonuses desc, title limit 1
    `) as unknown as { id: string, title: string, price_bonuses: number }[]
    return {
      balance,
      rating,
      affordable: affordable ? { id: affordable.id, title: affordable.title, priceBonuses: Number(affordable.price_bonuses) } : null,
      rows: rows.map(ledgerRow),
    }
  })
}

/** Область журнала и реестра: null — вся сеть, массив — точки, `undefined` — права нет. */
export async function bonusArea(access: Access): Promise<string[] | null | undefined> {
  if (can(access, 'shop.manage')) return null
  if (!can(access, 'bonus.grant')) return undefined
  return areaForScope(access, 'bonus.grant')
}

/**
 * «Журнал операцій з бонусами» (docs/04 `GET /bonuses/ledger`, docs/21 §14.9): ЛЮДИНА · БАЛАНС ·
 * ОПЕРАЦІЯ · ПОДІЯ · ДЕТАЛІ · ДАТА. «Баланс» — остаток после операции (`balance_after`), как у
 * эталона; курсор — id строки книги (порядок вставки).
 */
export async function ledger(ctx: Ctx, access: Access, f: LedgerFilter) {
  const area = await bonusArea(access)
  if (area === undefined) return { ok: false as const, code: 'forbidden' as const }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select pl2.id, pl2.currency, pl2.delta, pl2.balance_after, pl2.event, pl2.title, pl2.comment, pl2.created_at,
             act.full_name as actor_name, ${frameSelect()}
      from points_ledger pl2 join users u on u.id = pl2.user_id ${frameJoins()}
      left join users act on act.id = pl2.actor_id
      where pl2.currency = ${f.currency} ${frameWhere({ scope: area, q: f.q, includeArchived: true })}
        ${f.userId ? sql`and pl2.user_id = ${f.userId}::uuid` : sql``}
        ${f.event ? sql`and pl2.event = ${f.event}` : sql``}
        ${periodSql(sql`pl2.created_at`, f)}
        ${f.cursor ? sql`and pl2.id < ${f.cursor}` : sql``}
      order by pl2.id desc limit ${f.limit + 1}
    `) as unknown as Record<string, unknown>[]
    const page = rows.slice(0, f.limit)
    return {
      ok: true as const,
      rows: page.map(r => ({ ...ledgerRow(r), userId: r.user_id as string, fullName: r.full_name as string, position: (r.position as string | null) ?? null, location: (r.location as string | null) ?? null, unit: (r.unit as string | null) ?? null, actorName: (r.actor_name as string | null) ?? null })),
      cursor: rows.length > f.limit ? Number(page.at(-1)!.id) : null,
    }
  })
}

/**
 * «Керування бонусами» (docs/21 §14.9, `/gift-store/bonuses`): ПІБ · Посада · Місто · Підрозділ ·
 * Мітки · Поточна кількість бонусів. Люди без операций — с нулём: реестр — это все сотрудники
 * области, а не только те, у кого была операция.
 */
export async function balances(ctx: Ctx, access: Access, f: BalancesFilter) {
  const area = await bonusArea(access)
  if (area === undefined) return { ok: false as const, code: 'forbidden' as const }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`
      select ${frameSelect()},
             coalesce((select b.balance_after from points_ledger b where b.user_id = u.id and b.currency = 'bonuses' order by b.id desc limit 1), 0)::int as balance
      from users u ${frameJoins()}
      where true ${frameWhere({ scope: area, q: f.q })}
      order by u.full_name
      limit ${f.perPage} offset ${(f.page - 1) * f.perPage}
    `) as unknown as Record<string, unknown>[]
    const [{ total }] = await tx.execute(sql`
      select count(*)::int as total from users u ${frameJoins()} where true ${frameWhere({ scope: area, q: f.q })}
    `) as unknown as [{ total: number }]
    return {
      ok: true as const,
      total: Number(total),
      rows: rows.map(r => ({ userId: r.user_id as string, fullName: r.full_name as string, position: (r.position as string | null) ?? null, city: (r.city as string | null) ?? null, unit: (r.unit as string | null) ?? null, location: (r.location as string | null) ?? null, tags: (r.tags as string[] | null) ?? [], balance: Number(r.balance) })),
    }
  })
}

export type AdjustError = 'forbidden' | 'not_found' | 'self' | 'insufficient'

/**
 * «Нарахувати вручну» (docs/21 §7.5: «вручную наставником с обязательной причиной»; docs/04
 * `POST /bonuses/adjust`): начисление или списание бонусов со знаком и причиной.
 *
 * `[решение]` Вручную — только бонусы: баллы рейтинга начисляются лишь за выполненные задания,
 * иначе рейтинг перестаёт быть учебным (та же логика, что `docs/v2/38` §7.1 для индекса).
 * `[решение]` Себе начислить нельзя, даже администратору: деньги в своих руках — конфликт
 * интересов; начисление себе делает коллега. Списание ниже нуля — 409, а не обрезка до нуля.
 */
export async function adjustBonuses(ctx: Ctx, access: Access, input: BonusAdjustInput): Promise<{ ok: true, balance: number } | { ok: false, code: AdjustError, details?: Record<string, unknown> }> {
  const area = can(access, 'bonus.grant') ? await areaForScope(access, 'bonus.grant') : undefined
  if (area === undefined) return { ok: false, code: 'forbidden' }
  if (input.userId === ctx.actorId) return { ok: false, code: 'self' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [person] = await personById(tx, { kind: users.kind, status: users.status }, input.userId)
    if (!person || person.kind !== EMPLOYEE) return { ok: false as const, code: 'not_found' as const }
    if (area !== null) {
      const inArea = await tx.execute(sql`
        select 1 from users u ${frameJoins()} where u.id = ${input.userId}::uuid ${scopeSql(area, sql`pl.location_id`)} limit 1
      `) as unknown as unknown[]
      if (!inArea.length) return { ok: false as const, code: 'forbidden' as const }
    }
    const r = await postEntry(tx, { tenantId: ctx.tenantId, userId: input.userId, currency: 'bonuses', delta: input.delta, event: 'manual', comment: input.comment, actorId: ctx.actorId })
    if (!r.ok) return { ok: false as const, code: 'insufficient' as const, details: { balance: r.balance } }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'bonus.adjust', entity: 'user', entityId: input.userId, before: { balance: r.balanceAfter - input.delta }, after: { balance: r.balanceAfter, delta: input.delta, comment: input.comment } })
    if (input.delta > 0) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: input.userId, code: 'bonus_earned', payload: { amount: input.delta, title: input.comment, balance: r.balanceAfter, url: '/learn/bonuses' }, dedupKey: `bonus_earned:${r.id}` })
    }
    return { ok: true as const, balance: r.balanceAfter }
  })
}
