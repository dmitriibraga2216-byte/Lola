import { and, eq } from 'drizzle-orm'
import ukDict from '../../i18n/locales/uk.json'
import enDict from '../../i18n/locales/en.json'
import { translations, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'

/**
 * Переводы интерфейса (docs/24 §3.6, §7.4): переопределение строк словаря тенантом.
 * Стандартный словарь — `i18n/locales/<locale>.json` (плоские ключи `a.b.c`); переопределения —
 * таблица `translations`, отдельно от словаря, обновление системы их не затирает (§12.3).
 * Клиент получает `GET /translations/:locale` и накладывает поверх локали (`mergeLocaleMessage`).
 * Кеш переопределений — на процесс, сбрасывается при любой записи.
 */

export interface Ctx { tenantId: string, actorId: string }
export type Locale = 'uk' | 'en'

// ── Стандартный словарь ──

const dictCache = new Map<Locale, Record<string, string>>()

function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else out[key] = String(v)
  }
  return out
}

export function defaultDictionary(locale: Locale): Record<string, string> {
  const hit = dictCache.get(locale)
  if (hit) return hit
  // Словари вшиты в сборку (json-импорт), поэтому не зависят от cwd процесса
  const dict = flatten((locale === 'en' ? enDict : ukDict) as Record<string, unknown>)
  dictCache.set(locale, dict)
  return dict
}

// ── Переопределения ──

const overridesCache = new Map<string, Record<string, string>>()
const cacheKey = (tenantId: string, locale: Locale) => `${tenantId}:${locale}`

export function invalidateTranslations(tenantId: string): void {
  for (const k of [...overridesCache.keys()]) if (k.startsWith(`${tenantId}:`)) overridesCache.delete(k)
}

/** Карта key → value для клиента; кешируется. */
export async function tenantOverrides(tenantId: string, locale: Locale): Promise<Record<string, string>> {
  const key = cacheKey(tenantId, locale)
  const hit = overridesCache.get(key)
  if (hit) return hit
  const rows = await withTenant(tenantId, null, tx => tx.select({ key: translations.key, value: translations.value }).from(translations).where(eq(translations.locale, locale)))
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  overridesCache.set(key, map)
  return map
}

export interface TranslationRow {
  key: string
  standard: string | null
  custom: string | null
  updatedBy: string | null
  updatedAt: string | null
}

/** Таблица экрана: ключ · стандартный текст · свой · кто · когда; поиск по ключу и тексту, «только изменённые». */
export async function listTranslations(ctx: Ctx, q: { locale: Locale, q?: string, changedOnly?: boolean, page?: number, perPage?: number }): Promise<{ items: TranslationRow[], total: number, changed: number }> {
  const dict = defaultDictionary(q.locale)
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ key: translations.key, value: translations.value, updatedAt: translations.updatedAt, updatedBy: users.fullName })
    .from(translations).leftJoin(users, eq(users.id, translations.updatedBy)).where(eq(translations.locale, q.locale)))
  const custom = new Map(rows.map(r => [r.key, r]))
  const keys = q.changedOnly ? [...custom.keys()] : [...new Set([...Object.keys(dict), ...custom.keys()])]
  const needle = q.q?.trim().toLowerCase()
  const all: TranslationRow[] = keys.sort().map((key) => {
    const c = custom.get(key)
    return { key, standard: dict[key] ?? null, custom: c?.value ?? null, updatedBy: c?.updatedBy ?? null, updatedAt: c?.updatedAt?.toISOString() ?? null }
  }).filter(r => !needle || r.key.toLowerCase().includes(needle) || (r.standard ?? '').toLowerCase().includes(needle) || (r.custom ?? '').toLowerCase().includes(needle))
  const perPage = Math.min(Math.max(q.perPage ?? 50, 1), 500)
  const page = Math.max(q.page ?? 1, 1)
  return { items: all.slice((page - 1) * perPage, page * perPage), total: all.length, changed: custom.size }
}

export async function setTranslation(ctx: Ctx, input: { locale: Locale, key: string, value: string }): Promise<TranslationRow> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [before] = await tx.select({ value: translations.value }).from(translations).where(and(eq(translations.locale, input.locale), eq(translations.key, input.key)))
    const [row] = await tx.insert(translations).values({ tenantId: ctx.tenantId, locale: input.locale, key: input.key, value: input.value, updatedBy: ctx.actorId })
      .onConflictDoUpdate({ target: [translations.tenantId, translations.locale, translations.key], set: { value: input.value, updatedBy: ctx.actorId, updatedAt: new Date() } })
      .returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'translation.set', entity: 'translation', entityId: row!.id, before: { key: input.key, value: before?.value ?? null }, after: { key: input.key, value: input.value, locale: input.locale } })
    invalidateTranslations(ctx.tenantId)
    const [who] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, ctx.actorId))
    return { key: input.key, standard: defaultDictionary(input.locale)[input.key] ?? null, custom: row!.value, updatedBy: who?.name ?? null, updatedAt: row!.updatedAt.toISOString() }
  })
}

/** «Повернути стандартний»: удалить переопределение ключа. */
export async function resetTranslation(ctx: Ctx, locale: Locale, key: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.delete(translations).where(and(eq(translations.locale, locale), eq(translations.key, key))).returning({ id: translations.id, value: translations.value })
    if (!row) return false
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'translation.reset', entity: 'translation', entityId: row.id, before: { key, value: row.value, locale } })
    invalidateTranslations(ctx.tenantId)
    return true
  })
}

/** «Повернути стандартний» на всём наборе локали. */
export async function resetAllTranslations(ctx: Ctx, locale: Locale): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.delete(translations).where(eq(translations.locale, locale)).returning({ key: translations.key })
    if (rows.length) await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'translation.reset_all', entity: 'translation', before: { locale, keys: rows.map(r => r.key) } })
    invalidateTranslations(ctx.tenantId)
    return rows.length
  })
}

/** Экспорт json — только свои тексты (чтобы перевести целиком и залить обратно). */
export async function exportTranslations(ctx: Ctx, locale: Locale): Promise<Record<string, string>> {
  const rows = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ key: translations.key, value: translations.value }).from(translations).where(eq(translations.locale, locale)))
  return Object.fromEntries(rows.sort((a, b) => a.key.localeCompare(b.key)).map(r => [r.key, r.value]))
}

/** Импорт json: ключи вне словаря пропускаются, значение равное стандартному — снимает переопределение. */
export async function importTranslations(ctx: Ctx, locale: Locale, items: Record<string, string>): Promise<{ set: number, reset: number, skipped: string[] }> {
  const dict = defaultDictionary(locale)
  const skipped: string[] = []
  let set = 0
  let reset = 0
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    for (const [key, value] of Object.entries(items)) {
      if (!(key in dict)) { skipped.push(key); continue }
      if (dict[key] === value) {
        const r = await tx.delete(translations).where(and(eq(translations.locale, locale), eq(translations.key, key))).returning({ id: translations.id })
        if (r.length) reset++
        continue
      }
      await tx.insert(translations).values({ tenantId: ctx.tenantId, locale, key, value, updatedBy: ctx.actorId })
        .onConflictDoUpdate({ target: [translations.tenantId, translations.locale, translations.key], set: { value, updatedBy: ctx.actorId, updatedAt: new Date() } })
      set++
    }
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'translation.import', entity: 'translation', after: { locale, set, reset, skipped: skipped.length } })
  })
  invalidateTranslations(ctx.tenantId)
  return { set, reset, skipped }
}
