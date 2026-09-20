import { eq, sql } from 'drizzle-orm'
import { tenants } from '../db/schema'
import { withTenant, type TenantTx } from '../utils/withTenant'
import {
  ACCENT_TOKENS, MODULES, tenantSettingsSchema, type AccentToken, type ModuleCode, type PoliciesPatch, type TenantPatch, type TenantSettings,
} from '../../shared/schemas/settings'
import { recordAudit } from './audit'
import { logSecurity } from './securityLog'

/**
 * Настройки простору (docs/24 §3, §7.1): `tenants.settings jsonb` читается через единую zod-схему с дефолтами,
 * пишется patch-ом поверх текущего; каждое изменение — в `audit_log` со старым и новым значением (только diff),
 * критичные (политики, модули) — ещё и в журнал безопасности (`settings.security_changed`, critical).
 * `tenants` без RLS: любой update — строго `where id = tenantId`.
 */

export interface Ctx { tenantId: string, actorId: string }

/** Полные настройки с дефолтами. Неизвестные ключи не теряются: schema их пропускает при чтении, а запись делает jsonb-merge. */
export async function readSettings(tx: TenantTx, tenantId: string): Promise<TenantSettings> {
  const [t] = await tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId))
  return tenantSettingsSchema.parse(t?.settings ?? {})
}

export async function tenantSettings(ctx: Ctx): Promise<TenantSettings> {
  return withTenant(ctx.tenantId, ctx.actorId, tx => readSettings(tx, ctx.tenantId))
}

/** Разница двух плоских/вложенных объектов — только изменившиеся листья, для audit_log. */
export function diff(before: unknown, after: unknown, path = ''): Record<string, { before: unknown, after: unknown }> {
  const out: Record<string, { before: unknown, after: unknown }> = {}
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) Object.assign(out, diff(before[k], after[k], path ? `${path}.${k}` : k))
    return out
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out[path || '$'] = { before, after }
  return out
}

/** Слить patch в одну группу настроек: только переданные ключи, остальное — как было. */
async function writeGroup<K extends keyof TenantSettings>(tx: TenantTx, ctx: Ctx, group: K, patch: Partial<TenantSettings[K]>, opts: { critical?: boolean } = {}) {
  const before = await readSettings(tx, ctx.tenantId)
  const merged = { ...(before[group] as object), ...patch }
  // Валидация всей группы целиком — чтобы кросс-правила (например, тихие часы) сработали
  const next = tenantSettingsSchema.parse({ ...before, [group]: merged })
  const changes = diff(before[group], next[group])
  if (Object.keys(changes).length === 0) return { settings: next, changes }
  await tx.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{${String(group)}}`}::text[], ${JSON.stringify(next[group])}::jsonb), updated_at = now() where id = ${ctx.tenantId}::uuid`)
  await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: `settings.${String(group)}`, entity: 'tenant', entityId: ctx.tenantId, before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before])), after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after])) })
  if (opts.critical) {
    // docs/24 §7.1: политики, роли, модули — дополнительно в журнал безопасности (critical → письмо администраторам)
    await logSecurity({ tenantId: ctx.tenantId, userId: ctx.actorId, event: 'settings.security_changed', meta: { group, changed: Object.keys(changes) } })
  }
  return { settings: next, changes }
}

// ── Политики (docs/24 §3.4, §3.4.1): сохраняются пачкой, любые группы частично ──

export async function updatePolicies(ctx: Ctx, patch: PoliciesPatch) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const before = await readSettings(tx, ctx.tenantId)
    const merged: Record<string, unknown> = { ...before.policies }
    for (const [g, v] of Object.entries(patch)) if (v) merged[g] = { ...(before.policies as Record<string, object>)[g], ...v }
    const r = await writeGroup(tx, ctx, 'policies', merged as Partial<TenantSettings['policies']>, { critical: true })
    return r.settings.policies
  })
}

// ── Модули (docs/24 §3.2, Г-24.2) ──

export async function updateModules(ctx: Ctx, patch: Partial<Record<ModuleCode, boolean>>) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const r = await writeGroup(tx, ctx, 'modules', patch, { critical: true })
    return r.settings.modules
  })
}

/** Включён ли модуль — для middleware маршрутов и меню. */
export async function moduleEnabled(tx: TenantTx, tenantId: string, module: ModuleCode): Promise<boolean> {
  const s = await readSettings(tx, tenantId)
  return s.modules[module]
}

export function enabledModules(s: TenantSettings): ModuleCode[] {
  return MODULES.filter(m => s.modules[m])
}

// ── Простір: колонки tenants + branding.accent + settings.space/defaults/quietHours (docs/24 §3.1, §3.3, §6) ──

export interface TenantSpace {
  id: string
  name: string
  slug: string
  slugLocked: boolean
  locale: string
  timezone: string
  plan: string
  accent: AccentToken
  logoKey: string | null
  space: TenantSettings['space']
  defaults: TenantSettings['defaults']
  quietHours: TenantSettings['quietHours']
  modules: TenantSettings['modules']
}

/**
 * Slug заблокирован после первого входа сотрудника (docs/29 Б.12 — без редиректов): любая сессия человека,
 * у которого нет роли admin. Пока в простір заходили только администраторы — адрес можно менять.
 */
async function slugLocked(tx: TenantTx): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1 from sessions s
    where not exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = s.user_id and r.code = 'admin')
    limit 1
  `) as unknown as unknown[]
  return rows.length > 0
}

export function accentOf(branding: unknown): AccentToken {
  const a = (branding as { accent?: unknown } | null)?.accent
  return typeof a === 'string' && (ACCENT_TOKENS as readonly string[]).includes(a) ? a as AccentToken : 'sun'
}

export async function tenantSpace(ctx: Ctx): Promise<TenantSpace> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId))
    if (!t) throw new Error('tenant not found')
    const s = tenantSettingsSchema.parse(t.settings ?? {})
    const branding = (t.branding ?? {}) as { accent?: string, logo_key?: string }
    return {
      id: t.id, name: t.name, slug: t.slug, slugLocked: await slugLocked(tx), locale: t.locale, timezone: t.timezone, plan: t.plan,
      accent: accentOf(branding), logoKey: branding.logo_key ?? null,
      space: s.space, defaults: s.defaults, quietHours: s.quietHours, modules: s.modules,
    }
  })
}

export type TenantUpdateError = 'slug_taken' | 'slug_locked'

export async function updateTenantSpace(ctx: Ctx, patch: TenantPatch): Promise<{ ok: true, space: TenantSpace } | { ok: false, code: TenantUpdateError }> {
  const r = await withTenant(ctx.tenantId, ctx.actorId, async (tx): Promise<TenantUpdateError | null> => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, ctx.tenantId))
    if (!t) throw new Error('tenant not found')
    const before: Record<string, unknown> = { name: t.name, slug: t.slug, locale: t.locale, timezone: t.timezone, accent: accentOf(t.branding) }
    const after: Record<string, unknown> = { ...before }

    if (patch.slug !== undefined && patch.slug !== t.slug) {
      if (await slugLocked(tx)) return 'slug_locked'
      // tenants без RLS — уникальность проверяем явно, чтобы отдать понятный код, а не 500
      const taken = await tx.execute(sql`select 1 from tenants where slug = ${patch.slug} and id <> ${ctx.tenantId}::uuid`) as unknown as unknown[]
      if (taken.length) return 'slug_taken'
      after.slug = patch.slug
    }
    if (patch.name !== undefined) after.name = patch.name
    if (patch.locale !== undefined) after.locale = patch.locale
    if (patch.timezone !== undefined) after.timezone = patch.timezone
    if (patch.accent !== undefined) after.accent = patch.accent // только токен палитры (docs/29 Б.14), проверено zod

    const changes = diff(before, after)
    if (Object.keys(changes).length) {
      await tx.execute(sql`
        update tenants set name = ${after.name as string}, slug = ${after.slug as string}, locale = ${after.locale as string}, timezone = ${after.timezone as string},
          branding = coalesce(branding, '{}'::jsonb) || jsonb_build_object('accent', ${after.accent as string}::text), updated_at = now()
        where id = ${ctx.tenantId}::uuid
      `)
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'settings.tenant', entity: 'tenant', entityId: ctx.tenantId, before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before])), after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after])) })
    }
    if (patch.space) await writeGroup(tx, ctx, 'space', patch.space)
    if (patch.defaults) await writeGroup(tx, ctx, 'defaults', patch.defaults)
    if (patch.quietHours) await writeGroup(tx, ctx, 'quietHours', patch.quietHours)
    return null
  })
  if (r) return { ok: false, code: r }
  return { ok: true, space: await tenantSpace(ctx) }
}
