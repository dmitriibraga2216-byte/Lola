import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { absenceNorms, locations, tenants, userPlacements, users } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { ABSENCE_DEFAULTS, type AbsenceNormPut } from '../../shared/schemas/absences'
import type { AbsenceNormScope } from '../../shared/enums'
import { recordAudit } from './audit'
import { personById } from './repo/people'

/**
 * Нормы отпуска и больничного (docs/v2/38 §3.6, §7.12–7.14; блок «Кількість днів відпустки»
 * настроек компании — docs/v2/39 П-24.1, `38` §5.4). **Справочная величина, не кадровый учёт**
 * (§7.12): Lola не начисляет и не списывает дни.
 *
 * Разрешение — по каждому виду отдельно, первое непустое снизу вверх: человек → точка, где он
 * числится основным размещением сейчас, → компания → системный дефолт (24 и 5). Норма привязана
 * к календарному году. PR-39 даёт уровни компании и точки на экране настроек и общую функцию
 * разрешения; корректировка человека с причиной и остаток по фактам отсутствий — PR-33.
 */

interface Ctx { tenantId: string, actorId: string }

export type NormSource = AbsenceNormScope | 'system'
export interface ResolvedNorm { value: number, source: NormSource }
export interface ResolvedNorms { vacation: ResolvedNorm, sick: ResolvedNorm }

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v))

/** Текущий календарный год по часовому поясу пространства (считает БД): 31 декабря в 23:30 по Киеву — ещё старый год. */
export async function currentYear(tx: TenantTx, tenantId: string): Promise<number> {
  const [t] = await tx.select({ year: sql<number>`extract(year from now() at time zone ${tenants.timezone})::int` }).from(tenants).where(eq(tenants.id, tenantId))
  return Number(t?.year ?? new Date().getUTCFullYear())
}

/**
 * Разрешение нормы (`38` §7.13). `locationId` — точка расчёта; если не передана, берётся точка
 * основного размещения человека на сегодня (§7.14: действует норма той точки, где человек
 * числится на дату расчёта).
 */
export async function resolveAbsenceNorms(tx: TenantTx, input: { year: number, userId?: string | null, locationId?: string | null }): Promise<ResolvedNorms> {
  let locationId = input.locationId ?? null
  if (!locationId && input.userId) {
    const [p] = await tx.select({ locationId: userPlacements.locationId }).from(userPlacements)
      .where(and(eq(userPlacements.userId, input.userId), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    locationId = p?.locationId ?? null
  }
  const rows = await tx.select().from(absenceNorms).where(and(
    eq(absenceNorms.year, input.year),
    sql`(${absenceNorms.scopeType} = 'tenant'
      or (${absenceNorms.scopeType} = 'location' and ${absenceNorms.scopeId} = ${locationId}::uuid)
      or (${absenceNorms.scopeType} = 'user' and ${absenceNorms.scopeId} = ${input.userId ?? null}::uuid))`,
  ))
  const at = (scope: AbsenceNormScope) => rows.find(r => r.scopeType === scope)
  const pick = (field: 'vacationDays' | 'sickDays', fallback: number): ResolvedNorm => {
    for (const scope of ['user', 'location', 'tenant'] as const) {
      const v = num(at(scope)?.[field])
      if (v !== null) return { value: v, source: scope }
    }
    return { value: fallback, source: 'system' }
  }
  return { vacation: pick('vacationDays', ABSENCE_DEFAULTS.vacationDays), sick: pick('sickDays', ABSENCE_DEFAULTS.sickDays) }
}

export interface AbsenceNormsOverview {
  year: number
  defaults: typeof ABSENCE_DEFAULTS
  /** Норма компании на год; null в поле — не задана, действует системный дефолт */
  tenant: { vacationDays: number | null, sickDays: number | null }
  /** Точки области: переопределение (null — наследует от компании) */
  locations: { locationId: string, name: string, vacationDays: number | null, sickDays: number | null }[]
}

/**
 * Блок «Кількість днів відпустки» (`38` §5.4): норма компании и «Перевизначення по точках».
 * `area` — точки области права (`areaForScope`), null — весь тенант.
 */
export async function absenceNormsOverview(ctx: Ctx, year: number | undefined, area: string[] | null): Promise<AbsenceNormsOverview> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const y = year ?? await currentYear(tx, ctx.tenantId)
    const rows = await tx.select().from(absenceNorms).where(and(eq(absenceNorms.year, y), inArray(absenceNorms.scopeType, ['tenant', 'location'])))
    const t = rows.find(r => r.scopeType === 'tenant')
    const locs = await tx.select({ id: locations.id, name: locations.name }).from(locations)
      .where(and(eq(locations.isActive, true), area === null ? undefined : area.length ? inArray(locations.id, area) : sql`false`))
      .orderBy(asc(locations.name))
    const byLoc = new Map(rows.filter(r => r.scopeType === 'location').map(r => [r.scopeId!, r]))
    return {
      year: y,
      defaults: ABSENCE_DEFAULTS,
      tenant: { vacationDays: num(t?.vacationDays), sickDays: num(t?.sickDays) },
      locations: locs.map(l => ({ locationId: l.id, name: l.name, vacationDays: num(byLoc.get(l.id)?.vacationDays), sickDays: num(byLoc.get(l.id)?.sickDays) })),
    }
  })
}

/** Точка, к которой относится уровень: для проверки области права у точки и человека. */
export async function normTargetLocation(ctx: Ctx, input: Pick<AbsenceNormPut, 'scopeType' | 'scopeId'>): Promise<{ found: boolean, locationId: string | null }> {
  if (input.scopeType === 'tenant') return { found: true, locationId: null }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (input.scopeType === 'location') {
      const [l] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, input.scopeId!))
      return { found: !!l, locationId: l?.id ?? null }
    }
    const [p] = await personById(tx, { id: users.id, kind: users.kind }, input.scopeId!)
    // Норма отсутствий — у сотрудника; у кандидата отпуска нет (`38` §1)
    if (!p || p.kind !== 'employee') return { found: false, locationId: null }
    const [pl] = await tx.select({ locationId: userPlacements.locationId }).from(userPlacements)
      .where(and(eq(userPlacements.userId, input.scopeId!), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
    return { found: true, locationId: pl?.locationId ?? null }
  })
}

export interface NormRow { scopeType: AbsenceNormScope, scopeId: string | null, year: number, vacationDays: number | null, sickDays: number | null }

/**
 * `PUT /absence-norms` (`38` §10): правка перезаписывает строку года целиком (`38` §4 — у нормы
 * нет состояний), прежнее значение — в `audit_log`. Опущенное поле сохраняет прежнее значение;
 * оба `null` снимают переопределение уровня (строка удаляется — уровень снова наследует).
 */
export async function putAbsenceNorm(ctx: Ctx, input: AbsenceNormPut): Promise<NormRow> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const scopeCond = input.scopeId === null ? isNull(absenceNorms.scopeId) : eq(absenceNorms.scopeId, input.scopeId)
    const [cur] = await tx.select().from(absenceNorms).where(and(eq(absenceNorms.scopeType, input.scopeType), scopeCond, eq(absenceNorms.year, input.year)))
    const vacationDays = input.vacationDays !== undefined ? input.vacationDays : num(cur?.vacationDays)
    const sickDays = input.sickDays !== undefined ? input.sickDays : num(cur?.sickDays)
    const before = cur ? { vacationDays: num(cur.vacationDays), sickDays: num(cur.sickDays) } : null
    if (vacationDays === null && sickDays === null) {
      if (cur) await tx.delete(absenceNorms).where(eq(absenceNorms.id, cur.id))
    }
    else {
      await tx.insert(absenceNorms).values({
        tenantId: ctx.tenantId, scopeType: input.scopeType, scopeId: input.scopeId, year: input.year,
        vacationDays: vacationDays === null ? null : String(vacationDays), sickDays: sickDays === null ? null : String(sickDays),
        reason: input.reason ?? null, setBy: ctx.actorId,
      }).onConflictDoUpdate({
        target: [absenceNorms.tenantId, absenceNorms.scopeType, absenceNorms.scopeId, absenceNorms.year],
        set: { vacationDays: vacationDays === null ? null : String(vacationDays), sickDays: sickDays === null ? null : String(sickDays), reason: input.reason ?? null, setBy: ctx.actorId, updatedAt: new Date() },
      })
    }
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'absence_norm.set', entity: 'absence_norm', entityId: input.scopeId,
      before: before ? { scopeType: input.scopeType, year: input.year, ...before } : null,
      after: { scopeType: input.scopeType, year: input.year, vacationDays, sickDays, reason: input.reason ?? null },
    })
    return { scopeType: input.scopeType, scopeId: input.scopeId, year: input.year, vacationDays, sickDays }
  })
}
