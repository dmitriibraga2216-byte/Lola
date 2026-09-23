import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { limitNotices, platformAudit } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import type { LimitAxis, LimitNoticeLevel } from '../../shared/enums'
import { GIB } from './tenantLimits'
import { enqueueNotification } from './notifications'
import { EMPLOYEES_ONLY } from './repo/people'
import { defaultDictionary } from './translations'
import { AXIS_METER, LIMIT_WARN_PCT, levelOf, usageByAxis, type AxisDegradation } from './usageCounters'

/**
 * Предупреждения по осям лимита: баннер (`35` §5.5, §7.9) и уведомления
 * `limit_warning` / `limit_exceeded` (`35` §8, решение docs/v2/44 В-16).
 *
 * **Механизм существующий, не новый.** Уведомления идут через обычный `enqueueNotification`
 * теми же двумя кодами, что и до пакета (`notifications.ts` DEFAULT_TEMPLATES); добавлен
 * машинный `axis` в payload **рядом** с человекочитаемым `resource` (В-16: замена сломала бы
 * шаблоны), и ключ дедупликации переведён на `axis` — прежний включал локализуемую подпись,
 * и смена формулировки давала второе письмо о том же лимите.
 *
 * `limit_notices` держит **состояние**, а не журнал: одна открытая запись на ось и уровень
 * (частичный уникальный индекс миграции 0061). Порог 80 % — `LIMIT_WARN_PCT`.
 */

/** Одна открытая запись на ось и уровень; `dismissed_until` прячет баннер на 24 часа (§7.9 п. 2). */
export const DISMISS_HOURS = 24

export interface NoticeRow {
  id: string
  axis: LimitAxis
  level: LimitNoticeLevel
  valueAtRaise: number
  limitAtRaise: number | null
  raisedAt: string
  dismissedUntil: string | null
  /** Что перестало работать (`35` §7.1, столбец «При исчерпании») — для текста баннера. */
  degradation: AxisDegradation | null
}

/**
 * Привести открытые записи оси к фактическому уровню (§7.9 п. 1, 3).
 *
 * Поднимает `warn` при ≥80 %, `exceeded` при ≥100 %; при падении ниже 80 % закрывает обе
 * `resolved_at` — «следующий подъём — новая запись». Возвращает уровень, на который ось
 * перешла **в этом вызове** (`null` — ничего не изменилось): по нему решается, слать ли
 * уведомление, чтобы счётчик, тикающий каждую секунду, не слал письмо каждую секунду.
 */
export async function syncNotice(tenantId: string, axis: LimitAxis, used: number, limit: number | null): Promise<LimitNoticeLevel | null> {
  const level = levelOf(used, limit)
  const raised = await withTenant(tenantId, null, async (tx) => {
    const open = await tx.select().from(limitNotices)
      .where(and(eq(limitNotices.tenantId, tenantId), eq(limitNotices.axis, axis), isNull(limitNotices.resolvedAt)))
    const close = async (lv: LimitNoticeLevel) => {
      await tx.update(limitNotices).set({ resolvedAt: new Date() })
        .where(and(eq(limitNotices.tenantId, tenantId), eq(limitNotices.axis, axis), eq(limitNotices.level, lv), isNull(limitNotices.resolvedAt)))
    }
    if (level === 'ok') {
      for (const r of open) await close(r.level as LimitNoticeLevel)
      return null
    }
    // `warn` не гасится при переходе в `exceeded`: баннер показывает наиболее тяжёлый уровень
    // (§7.9 п. 1), а возврат с 100 % на 85 % обязан снова показать предупреждение.
    if (open.some(r => r.level === level)) return null
    await tx.insert(limitNotices).values({
      tenantId, axis, level, valueAtRaise: used, limitAtRaise: limit,
    }).onConflictDoNothing()
    return level
  })
  if (raised) await notifyAdmins(tenantId, axis, raised, used, limit)
  return raised
}

/**
 * Обойти все одиннадцать осей и привести записи к факту. Это тело задачи `billing.limit_scan`
 * (`35` §11, ежечасно) и точка, из которой закрываются записи по осям, которые никто не
 * трогает операциями (освободилось место — предупреждение должно уйти само).
 */
export async function limitScan(tenantId: string): Promise<{ raised: number, axes: number }> {
  const rows = await usageByAxis(tenantId)
  let raised = 0
  for (const r of rows) {
    if (await syncNotice(tenantId, r.axis, r.used, r.limit)) raised++
  }
  return { raised, axes: rows.length }
}

/** Ежечасный проход по активным тенантам (воркер `billing.limit_scan`). */
export async function limitScanAll(): Promise<number> {
  const rows = await db.execute(sql`select id from tenants where status = 'active'`) as unknown as { id: string }[]
  let n = 0
  for (const t of rows) {
    const r = await limitScan(t.id).catch(() => null)
    if (r) n += r.raised
  }
  return n
}

/**
 * Открытые записи для баннера: `exceeded` тяжелее `warn`, скрытые крестиком не показываются,
 * пока не истекли 24 часа (§7.9 п. 2). Экран сам решает, показать ли «та ще N».
 */
export async function activeNotices(tenantId: string, at: Date = new Date()): Promise<NoticeRow[]> {
  const rows = await withTenant(tenantId, null, tx => tx.select().from(limitNotices)
    .where(and(eq(limitNotices.tenantId, tenantId), isNull(limitNotices.resolvedAt)))
    .orderBy(desc(limitNotices.raisedAt)))
  return rows
    // `exceeded` закрыть нельзя — крестика нет (§7.9 п. 2), поэтому его `dismissed_until` не смотрим
    .filter(r => r.level === 'exceeded' || !r.dismissedUntil || r.dismissedUntil.getTime() <= at.getTime())
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'exceeded' ? -1 : 1))
    .map(r => ({
      id: r.id,
      axis: r.axis as LimitAxis,
      level: r.level as LimitNoticeLevel,
      valueAtRaise: r.valueAtRaise,
      limitAtRaise: r.limitAtRaise,
      raisedAt: r.raisedAt.toISOString(),
      dismissedUntil: r.dismissedUntil?.toISOString() ?? null,
      degradation: r.level === 'exceeded' ? AXIS_METER[r.axis as LimitAxis].onExhausted : null,
    }))
}

export type DismissResult = { ok: true, dismissedUntil: string } | { ok: false, code: 'not_found' | 'cannot_dismiss_exceeded' }

/** Крестик баннера: скрыть на 24 часа. У `exceeded` крестика нет — 409 (`35` §10, §7.9 п. 2). */
export async function dismissNotice(ctx: { tenantId: string, actorId: string }, id: string): Promise<DismissResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(limitNotices)
      .where(and(eq(limitNotices.tenantId, ctx.tenantId), eq(limitNotices.id, id), isNull(limitNotices.resolvedAt)))
    if (!row) return { ok: false as const, code: 'not_found' as const }
    if (row.level === 'exceeded') return { ok: false as const, code: 'cannot_dismiss_exceeded' as const }
    const until = new Date(Date.now() + DISMISS_HOURS * 3600_000)
    await tx.update(limitNotices).set({ dismissedUntil: until, dismissedBy: ctx.actorId })
      .where(eq(limitNotices.id, id))
    return { ok: true as const, dismissedUntil: until.toISOString() }
  })
}

/**
 * Уведомление админам тенанта и запись оператору платформы. Коды те же (`24` §8, `35` §8);
 * payload — `{axis, resource, used, limit, pct}`, где `axis` машинный (В-16), а `resource`,
 * `used`, `limit` — готовые строки для шаблона. Дедуп — сутки на связку `(код, ось, человек)`.
 */
async function notifyAdmins(tenantId: string, axis: LimitAxis, level: LimitNoticeLevel, used: number, limit: number | null): Promise<void> {
  const code = level === 'exceeded' ? 'limit_exceeded' : 'limit_warning'
  const dict = defaultDictionary('uk')
  const display = (n: number) => (axis === 'storage_bytes' ? `${(n / GIB).toFixed(1)} ГБ` : String(n))
  const payload = {
    axis,
    resource: dict[`billing.axis.${axis}`] ?? axis,
    used: display(used),
    limit: limit == null ? '∞' : display(limit),
    pct: limit == null || limit <= 0 ? 0 : Math.round(used / limit * 100),
    consequence: dict[`billing.limitConsequence.${axis}`] ?? '',
  }
  const day = new Date().toISOString().slice(0, 10)
  await withTenant(tenantId, null, async (tx: TenantTx) => {
    const admins = await tx.execute(sql`
      select distinct ur.user_id from user_roles ur join roles r on r.id = ur.role_id join users a on a.id = ur.user_id
      where r.code in ('admin', 'owner') and (ur.valid_until is null or ur.valid_until > now())
        and a.status = 'active' and not a.is_blocked ${EMPLOYEES_ONLY('a')}
    `) as unknown as { user_id: string }[]
    for (const a of admins) {
      // Ключ дедупликации — на оси, а не на локализуемой подписи (В-16)
      await enqueueNotification(tx, { tenantId, userId: a.user_id, code, payload, dedupKey: `${code}:${axis}:${tenantId}:${day}:${a.user_id}` })
    }
  })
  await db.insert(platformAudit).values({
    adminId: null, adminEmail: 'system', action: `tenant.${code}`,
    subjectTenantId: tenantId, entity: 'limit_notices', entityId: axis, after: payload,
  })
}

/** Порог из §7.9 — экспортируется для экранов, чтобы полоса красилась по тому же числу. */
export { LIMIT_WARN_PCT }
