import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  mediaAssets, planAddons, planChangeRequests, platformAudit, plans, tenantAddons, tenantLimits,
  tenantPayments, tenantSecrets, tenants,
} from '../db/schema'
import { currentRequestContext } from '../utils/requestContext'
import { platformDb, type PlatformAuth } from './platform'
import { invalidateTenant } from './tenantResolve'
import { effectiveLimits, invalidateLimits } from './tenantLimits'
import { enqueueForTenant } from './tenantQueue'
import { enqueueMediaProcess } from './queue'
import type { TenantLimitsInput } from '../../shared/schemas/platform'
import type { TenantPaymentInput } from '../../shared/schemas/billing'

/**
 * Жизненный цикл тенанта в панели оператора (docs/25 §7, §8; docs/24 §7 п. 5, §10):
 * suspend → вход закрыт, задачи стоят, данные целы; purge — только из suspended, по явной команде с подтверждением
 * slug, исполняется задачей `tenant.purge` через TENANT_PURGE_DELAY_DAYS (30) дней; до этого отменяется.
 * Каждое действие — в `platform_audit` с `request_context` (docs/25 §7 п. 5, CLAUDE.md п. 14).
 * Работает только под PLATFORM_DATABASE_URL; `update tenants` — всегда `where id = tenantId`.
 */

export const PURGE_DELAY_DAYS = () => Number(process.env.TENANT_PURGE_DELAY_DAYS || 30)
export const PURGE_QUEUE = 'tenant.purge'

// ── platform_audit ────────────────────────────────────────────────────

export interface PlatformAuditInput {
  action: string
  tenantId?: string | null
  entity: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}

export async function recordPlatformAudit(actor: PlatformAuth, input: PlatformAuditInput): Promise<void> {
  await platformDb().insert(platformAudit).values({
    adminId: actor.adminId,
    adminEmail: actor.email,
    action: input.action,
    subjectTenantId: input.tenantId ?? null,
    entity: input.entity,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    requestContext: currentRequestContext(),
  })
}

export async function listPlatformAudit(filter: { tenantId?: string, limit?: number } = {}) {
  const db = platformDb()
  const q = db.select().from(platformAudit).orderBy(desc(platformAudit.createdAt)).limit(Math.min(filter.limit ?? 100, 500))
  const rows = filter.tenantId ? await q.where(eq(platformAudit.subjectTenantId, filter.tenantId)) : await q
  return rows.map(r => ({ ...r, id: String(r.id) }))
}

// ── Статусы ───────────────────────────────────────────────────────────

export type TenantActionResult = { ok: true, status: string, archivedAt: string | null, purgeAt: string | null }
  | { ok: false, code: 'not_found' | 'wrong_status' | 'confirm_mismatch' }

async function loadTenant(id: string) {
  const [t] = await platformDb().select().from(tenants).where(eq(tenants.id, id))
  return t ?? null
}

export function purgeAtOf(archivedAt: Date | null): Date | null {
  return archivedAt ? new Date(archivedAt.getTime() + PURGE_DELAY_DAYS() * 86_400_000) : null
}

const view = (t: { status: string, archivedAt: Date | null }): TenantActionResult => ({ ok: true, status: t.status, archivedAt: t.archivedAt?.toISOString() ?? null, purgeAt: purgeAtOf(t.archivedAt)?.toISOString() ?? null })

/**
 * Приостановка (docs/25 §8): только статус — сессии не трогаем, они получают 403 `tenant_suspended` на каждый запрос
 * и оживают после resume; приложение узнаёт сразу (кеш статуса сброшен).
 */
export async function suspendTenant(id: string, reason: string | null, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'active') return { ok: false, code: 'wrong_status' }
  const db = platformDb()
  const [after] = await db.update(tenants).set({ status: 'suspended', updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  await recordPlatformAudit(actor, { action: 'tenant.suspend', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'suspended', reason, slug: t.slug } })
  invalidateTenant(id)
  return view(after!)
}

/**
 * Медиа, застрявшие в `processing` на момент приостановки тенанта (docs/25 §5, долг из
 * `28` Spec 25 отк. (3)): пока тенант suspended, `media.process` для них не идёт и не повторяется
 * сам по себе — задача с сущностью, поставленная до приостановки, завершается `skipped` и не переставляется.
 */
async function stuckProcessingMedia(id: string): Promise<string[]> {
  const rows = await platformDb().select({ id: mediaAssets.id }).from(mediaAssets)
    .where(and(eq(mediaAssets.tenantId, id), eq(mediaAssets.status, 'processing')))
  return rows.map(r => r.id)
}

/** Возобновление из suspended: заодно переставляет `media.process` для медиа, застрявших в processing. */
export async function resumeTenant(id: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'suspended') return { ok: false, code: 'wrong_status' }
  const [after] = await platformDb().update(tenants).set({ status: 'active', updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  const stuck = await stuckProcessingMedia(id)
  await Promise.all(stuck.map(mediaId => enqueueMediaProcess(id, mediaId).catch(err => console.error('[tenant.resume] media.process', mediaId, err))))
  await recordPlatformAudit(actor, { action: 'tenant.resume', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'active', slug: t.slug, requeuedMedia: stuck.length } })
  invalidateTenant(id)
  return view(after!)
}

/**
 * Команда на удаление (docs/25 §8, docs/24 §7 п. 5): только из suspended, оператор подтверждает slug.
 * Ставится `tenant.purge` со стартом через 30 дней; статус archived + archived_at — мягкое удаление.
 */
export async function schedulePurge(id: string, confirmSlug: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'suspended') return { ok: false, code: 'wrong_status' }
  if (confirmSlug !== t.slug) return { ok: false, code: 'confirm_mismatch' }
  const archivedAt = new Date()
  const [after] = await platformDb().update(tenants).set({ status: 'archived', archivedAt, updatedAt: archivedAt }).where(eq(tenants.id, id)).returning()
  const purgeAt = purgeAtOf(archivedAt)!
  const jobId = await enqueueForTenant(PURGE_QUEUE, id, {}, { singletonKey: `purge:${id}`, startAfter: purgeAt }).catch((err) => {
    console.error('[tenant.purge] не удалось поставить задачу', err)
    return null
  })
  await recordPlatformAudit(actor, { action: 'tenant.purge_schedule', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status }, after: { status: 'archived', slug: t.slug, purgeAt: purgeAt.toISOString(), jobId } })
  invalidateTenant(id)
  return view(after!)
}

/** Отмена до срока: archived → suspended, задача снимается. */
export async function cancelPurge(id: string, actor: PlatformAuth): Promise<TenantActionResult> {
  const t = await loadTenant(id)
  if (!t) return { ok: false, code: 'not_found' }
  if (t.status !== 'archived') return { ok: false, code: 'wrong_status' }
  const db = platformDb()
  const [after] = await db.update(tenants).set({ status: 'suspended', archivedAt: null, updatedAt: new Date() }).where(eq(tenants.id, id)).returning()
  const [last] = await db.select({ after: platformAudit.after }).from(platformAudit)
    .where(sql`${platformAudit.subjectTenantId} = ${id} and ${platformAudit.action} = 'tenant.purge_schedule'`).orderBy(desc(platformAudit.createdAt)).limit(1)
  const jobId = (last?.after as { jobId?: string } | null)?.jobId
  if (jobId) {
    const { getBoss } = await import('./queue')
    await getBoss().then(b => b.cancel(PURGE_QUEUE, jobId)).catch(err => console.error('[tenant.purge] отмена задачи', err))
  }
  await recordPlatformAudit(actor, { action: 'tenant.purge_cancel', tenantId: id, entity: 'tenant', entityId: id, before: { status: t.status, archivedAt: t.archivedAt }, after: { status: 'suspended', slug: t.slug, jobId: jobId ?? null } })
  invalidateTenant(id)
  return view(after!)
}

// ── Лимиты ────────────────────────────────────────────────────────────

/**
 * Экран «Ліміти» панели оператора (docs/v2/35 §5.6, §6.3): лимит тарифа, переопределение и
 * **эффективное** значение по каждой из одиннадцати осей (docs/v2/35 §7.1).
 *
 * Эффективное значение берётся общей функцией `effectiveLimits` (docs/v2/44 В-5), а не
 * пересчитывается здесь: до PR-08 экран читал `max_users, max_storage_gb, max_sms_per_month`
 * сырым SQL и не знал ни про доплаты, ни про остальные восемь осей.
 */
export async function getTenantLimits(id: string) {
  const db = platformDb()
  const t = await loadTenant(id)
  if (!t) return null
  const [o] = await db.select().from(tenantLimits).where(eq(tenantLimits.tenantId, id))
  const [p] = await db.select().from(plans).where(eq(plans.code, t.plan))
  const effective = await effectiveLimits(id)
  return {
    plan: {
      code: t.plan,
      users: p?.maxUsers ?? null,
      storageGb: p?.maxStorageGb ?? null,
      smsPerMonth: p?.maxSmsPerMonth ?? null,
      candidates: p?.maxCandidates ?? null,
      aiGenerateOps: p?.maxAiGenerateOps ?? null,
      aiReviewOps: p?.maxAiReviewOps ?? null,
      aiInterviewOps: p?.maxAiInterviewOps ?? null,
      exportRows: p?.maxExportRows ?? null,
    },
    overrides: {
      users: o?.users ?? null,
      storageGb: o?.storageGb ?? null,
      smsPerMonth: o?.smsPerMonth ?? null,
      apiPerMinute: o?.apiPerMinute ?? null,
      webhooks: o?.webhooks ?? null,
      activeJobs: o?.activeJobs ?? null,
      candidates: o?.candidates ?? null,
      aiGenerateOps: o?.aiGenerateOps ?? null,
      aiReviewOps: o?.aiReviewOps ?? null,
      aiInterviewOps: o?.aiInterviewOps ?? null,
      exportRows: o?.exportRows ?? null,
    },
    /** Тариф + переопределение + доплаты, по осям и в единицах оси (docs/v2/35 §7.3). */
    effective: effective.axes,
    addons: effective.addons,
    subscription: effective.subscription,
  }
}

/**
 * Переопределение лимитов (docs/24 §4.4, docs/v2/35 §6.3): null — вернуться к тарифу.
 *
 * Строка `tenant_limits` с PR-08 держит ещё и состояние подписки (`status`, `paid_until`,
 * `ai_until` — docs/v2/35 §3.2), поэтому сброс всех переопределений удаляет её только тогда,
 * когда подписке нечего терять: статус `trial` и все три даты пусты. Иначе переопределения
 * обнуляются на месте — иначе «очистить лимиты» стирало бы оплаченный срок (docs/28 §v2-08).
 */
export async function setTenantLimits(id: string, input: TenantLimitsInput, actor: PlatformAuth) {
  const before = await getTenantLimits(id)
  if (!before) return null
  const db = platformDb()
  const values = {
    users: input.users ?? null,
    storageGb: input.storageGb ?? null,
    smsPerMonth: input.smsPerMonth ?? null,
    apiPerMinute: input.apiPerMinute ?? null,
    webhooks: input.webhooks ?? null,
    activeJobs: input.activeJobs ?? null,
    candidates: input.candidates ?? null,
    aiGenerateOps: input.aiGenerateOps ?? null,
    aiReviewOps: input.aiReviewOps ?? null,
    aiInterviewOps: input.aiInterviewOps ?? null,
    exportRows: input.exportRows ?? null,
  }
  const [row] = await db.select().from(tenantLimits).where(eq(tenantLimits.tenantId, id))
  const subscriptionIsEmpty = !row || (row.status === 'trial' && !row.paidUntil && !row.graceUntil && !row.aiUntil)
  if (Object.values(values).every(v => v === null) && subscriptionIsEmpty) {
    await db.delete(tenantLimits).where(eq(tenantLimits.tenantId, id))
  }
  else {
    await db.insert(tenantLimits).values({ tenantId: id, ...values, updatedBy: actor.adminId })
      .onConflictDoUpdate({ target: tenantLimits.tenantId, set: { ...values, updatedBy: actor.adminId, updatedAt: new Date() } })
  }
  await recordPlatformAudit(actor, { action: 'tenant.limits', tenantId: id, entity: 'tenant_limits', entityId: id, before: before.overrides, after: values })
  invalidateLimits(id)
  return getTenantLimits(id)
}

/**
 * Доплата тенанту (docs/v2/35 §3.5, §7.8 п. 1, §7.10): оператор подключает опцию из каталога
 * `plan_addons` — покупкой, подарком (`grant`, «Видати пакет операцій») или компенсацией.
 * `unit_step` пишется **снимком** каталога на момент подключения, чтобы пересмотр цен и шагов
 * не переписывал задним числом уже оплаченное. Приём денег остаётся ручным (`35` §10,
 * `44` §8): внешний платёжный провайдер в фазе 1 не подключается.
 *
 * Эффективный лимит пересчитывать не нужно — он считается одной функцией `effectiveLimits`,
 * которой достаточно сбросить кеш.
 */
export async function grantTenantAddon(
  tenantId: string,
  input: { addonCode: string, qty: number, validUntil?: string | null, source?: 'purchase' | 'grant' | 'compensation' },
  actor: PlatformAuth,
): Promise<{ ok: true, id: string } | { ok: false, code: 'not_found' | 'addon_unknown' | 'addon_not_allowed' }> {
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) return { ok: false, code: 'not_found' }
  const [addon] = await db.select().from(planAddons).where(eq(planAddons.code, input.addonCode))
  if (!addon) return { ok: false, code: 'addon_unknown' }
  // Каталог тарифа (`35` §6.2): опция вне `plans.addons_allowed` недоступна. Пустой список —
  // тариф ограничений не задаёт, доступны все публичные опции.
  const [plan] = await db.select().from(plans).where(eq(plans.code, t.plan))
  if (plan && plan.addonsAllowed.length > 0 && !plan.addonsAllowed.includes(addon.code)) return { ok: false, code: 'addon_not_allowed' }
  const [row] = await db.insert(tenantAddons).values({
    tenantId,
    addonCode: addon.code,
    qty: input.qty,
    unitStep: addon.unitStep,
    validUntil: input.validUntil ?? null,
    source: input.source ?? 'purchase',
  }).returning({ id: tenantAddons.id })
  await recordPlatformAudit(actor, { action: 'tenant.addon_grant', tenantId, entity: 'tenant_addons', entityId: row!.id, after: { addonCode: addon.code, qty: input.qty, unitStep: addon.unitStep, axis: addon.axis, source: input.source ?? 'purchase' } })
  invalidateLimits(tenantId)
  return { ok: true, id: row!.id }
}

// ── Оплата и смена тарифа (docs/v2/35 §3.5, §7.6, §7.8 п. 6, §10 — PR-10) ────────────────

/**
 * `date` (YYYY-MM-DD) + один биллинговый период, с зажимом дня в границы результирующего
 * месяца (31.01 + месяц → 28/29.02, а не «перепрыгнутый» март). Без внешней даты-библиотеки —
 * единственное место, где считается продление подписки (§7.8 п. 6).
 */
export function addBillingPeriod(dateIso: string, period: 'month' | 'year'): string {
  const [y, m, d] = dateIso.slice(0, 10).split('-').map(Number) as [number, number, number]
  const months = period === 'year' ? 12 : 1
  const total = (m - 1) + months
  const ny = y + Math.floor(total / 12)
  const nm = total % 12 // 0-based
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const nd = Math.min(d, lastDay)
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Приём платежа оператором вручную (`35` §10, `44` §8 — платёжный провайдер не подключён и
 * не появится в этом PR; `.env.example` реальных ключей не получает). Единственный способ
 * продвинуть `paid_until`/докупить аддон в системе сегодня.
 *
 * Правило §7.8 п. 6, критерий приёмки `35` §13 к. 6: продление считается **от прежней даты
 * окончания**, а не от даты платежа — даже если тенант десятый день в `readonly`. Это и
 * защищает оплаченные дни: пропуск платежа не даёт бесплатную отсрочку (дни просрочки не
 * возвращаются), но и не крадёт дни, за которые уже заплачено вперёд.
 */
export async function recordTenantPayment(
  tenantId: string,
  input: TenantPaymentInput,
  actor: PlatformAuth,
): Promise<
  | { ok: true, payment: typeof tenantPayments.$inferSelect, subscription: Awaited<ReturnType<typeof effectiveLimits>>['subscription'] }
  | { ok: false, code: 'not_found' | 'addon_unknown' }
> {
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) return { ok: false, code: 'not_found' }

  let periodFrom: string | null = null
  let periodTo: string | null = null

  if (input.kind === 'subscription') {
    const [row] = await db.select({ paidUntil: tenantLimits.paidUntil }).from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId))
    const period = input.billingPeriod ?? 'month'
    // «От прежней даты окончания» (§7.8 п. 6): даже просроченный paid_until — точка отсчёта,
    // а не «сегодня». Только первая оплата тенанта (paid_until никогда не было) считается от сегодня.
    periodFrom = row?.paidUntil ?? isoDate(new Date())
    periodTo = addBillingPeriod(periodFrom, period)
    await db.insert(tenantLimits).values({
      tenantId, billingPeriod: period, status: 'active', paidUntil: periodTo, graceUntil: null, updatedBy: actor.adminId,
    }).onConflictDoUpdate({
      target: tenantLimits.tenantId,
      set: { billingPeriod: period, status: 'active', paidUntil: periodTo, graceUntil: null, updatedBy: actor.adminId, updatedAt: new Date() },
    })
  }

  if (input.kind === 'addon') {
    if (!input.addonCode) return { ok: false, code: 'addon_unknown' }
    const [addon] = await db.select().from(planAddons).where(eq(planAddons.code, input.addonCode))
    if (!addon) return { ok: false, code: 'addon_unknown' }
  }

  const [payment] = await db.insert(tenantPayments).values({
    tenantId,
    kind: input.kind,
    planCode: input.kind === 'subscription' ? (input.planCode ?? t.plan) : null,
    addonCode: input.kind === 'addon' ? input.addonCode : null,
    billingPeriod: input.kind === 'subscription' ? (input.billingPeriod ?? 'month') : null,
    periodFrom,
    periodTo,
    amountMinor: input.amountMinor,
    currency: input.currency,
    paidAt: input.status === 'paid' ? new Date() : null,
    status: input.status,
    method: input.method ?? 'manual',
    invoiceNumber: input.invoiceNumber ?? null,
    comment: input.comment,
    createdBy: actor.adminId,
  }).returning()

  // Аддон покупается той же ручкой, что и грант оператора (`grantTenantAddon`), но со
  // `source='purchase'` и ссылкой на платёж — снимок `unit_step` берётся так же, из каталога.
  if (input.kind === 'addon' && input.addonCode) {
    const [addon] = await db.select().from(planAddons).where(eq(planAddons.code, input.addonCode))
    await db.insert(tenantAddons).values({
      tenantId,
      addonCode: addon!.code,
      qty: input.qty ?? 1,
      unitStep: addon!.unitStep,
      // `period` продлевается вместе с тарифом (§7.8 п. 1); без задачи автопродления (не
      // построена в этом PR) даём один оплаченный период от сегодня, `perpetual` — без срока.
      validUntil: addon!.term === 'period' ? addBillingPeriod(isoDate(new Date()), input.billingPeriod ?? 'month') : null,
      source: 'purchase',
      paymentId: payment!.id,
    })
  }

  await recordPlatformAudit(actor, {
    action: 'tenant.payment',
    tenantId,
    entity: 'tenant_payments',
    entityId: payment!.id,
    after: { kind: input.kind, amountMinor: input.amountMinor, currency: input.currency, periodFrom, periodTo, status: input.status },
  })
  invalidateLimits(tenantId)
  const eff = await effectiveLimits(tenantId)
  return { ok: true, payment: payment!, subscription: eff.subscription }
}

/** История платежей для панели оператора (`35` §5.6) — без пагинации, тенантов достаточно мало платежей. */
export async function listTenantPaymentsForOperator(tenantId: string) {
  return platformDb().select().from(tenantPayments).where(eq(tenantPayments.tenantId, tenantId)).orderBy(desc(tenantPayments.createdAt))
}

/**
 * Прямая смена тарифа оператором (§7.10 «может назначить любой план, включая
 * `is_public=false`»): в отличие от самообслуживания владельца (`35` §6.1, экран §5.2 —
 * отдельный PR, см. `docs/v2/46-progress.md`), preflight не считается — оператор берёт на
 * себя ответственность за превышения. `plan_change_requests` заводится сразу `applied`, для
 * той же истории, что видит владелец на `/settings/billing`.
 */
export async function changeTenantPlan(
  tenantId: string,
  input: { toPlanCode: string, billingPeriod: 'month' | 'year', comment: string },
  actor: PlatformAuth,
): Promise<{ ok: true, id: string } | { ok: false, code: 'not_found' | 'plan_unknown' }> {
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) return { ok: false, code: 'not_found' }
  const [plan] = await db.select().from(plans).where(eq(plans.code, input.toPlanCode))
  if (!plan) return { ok: false, code: 'plan_unknown' }
  const fromPlanCode = t.plan
  await db.update(tenants).set({ plan: input.toPlanCode }).where(eq(tenants.id, tenantId))
  await db.update(tenantLimits).set({ billingPeriod: input.billingPeriod, updatedBy: actor.adminId, updatedAt: new Date() }).where(eq(tenantLimits.tenantId, tenantId))
  const [row] = await db.insert(planChangeRequests).values({
    tenantId,
    fromPlanCode,
    toPlanCode: input.toPlanCode,
    billingPeriod: input.billingPeriod,
    status: 'applied',
    effectiveAt: isoDate(new Date()),
    decidedBy: actor.adminId,
    decidedAt: new Date(),
  }).returning({ id: planChangeRequests.id })
  await recordPlatformAudit(actor, { action: 'tenant.plan_change', tenantId, entity: 'plan_change_requests', entityId: row!.id, before: { plan: fromPlanCode }, after: { plan: input.toPlanCode, billingPeriod: input.billingPeriod, comment: input.comment } })
  invalidateLimits(tenantId)
  return { ok: true, id: row!.id }
}

/**
 * Точечное продление дат подписки без платежа (§5.6 «Продовжити доступ», «Продовжити ШІ»,
 * §7.10). В отличие от `setTenantLimits` (полная замена всех переопределений осей — форма
 * шлёт все поля разом), здесь трогается только то, что явно передано: `'paidUntil' in input`
 * отличает «не трогать» от «поставить null» (снять дату), а не считает и то и то отсутствием.
 */
export async function extendTenantDates(
  tenantId: string,
  input: { paidUntil?: string | null, graceUntil?: string | null, aiUntil?: string | null },
  actor: PlatformAuth,
): Promise<{ ok: true } | { ok: false, code: 'not_found' }> {
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) return { ok: false, code: 'not_found' }
  const set: Record<string, unknown> = {}
  if ('paidUntil' in input) set.paidUntil = input.paidUntil ?? null
  if ('graceUntil' in input) set.graceUntil = input.graceUntil ?? null
  if ('aiUntil' in input) set.aiUntil = input.aiUntil ?? null
  const [row] = await db.select({ tenantId: tenantLimits.tenantId }).from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId))
  if (row) await db.update(tenantLimits).set({ ...set, updatedBy: actor.adminId, updatedAt: new Date() }).where(eq(tenantLimits.tenantId, tenantId))
  else await db.insert(tenantLimits).values({ tenantId, ...set, updatedBy: actor.adminId })
  await recordPlatformAudit(actor, { action: 'tenant.extend', tenantId, entity: 'tenant_limits', entityId: tenantId, after: set })
  invalidateLimits(tenantId)
  return { ok: true }
}

/**
 * «Ігнорувати помилки TLS» для SMTP тенанта (docs/09 §9.7.1 п. 3, докс/33 D-050) — небезпечний
 * прапорець самопідписаного сертифіката релею; на відміну від решти полів SMTP тенант його не
 * бачить і не редагує, лише оператор платформи, і кожна зміна — у `platform_audit`. Пишемо
 * напряму в `tenant_secrets` через `platformDb()` (BYPASSRLS): тенантський `setSecret` тут не
 * підходить — `created_by` посилається на `users(id)`, а актор тут — `platformAdmins`.
 */
export async function setSmtpIgnoreTlsErrors(tenantId: string, ignoreTlsErrors: boolean, actor: PlatformAuth): Promise<void> {
  const { encrypt } = await import('./crypto')
  const { SECRET_KEYS } = await import('./secrets')
  const key = SECRET_KEYS.smtp.IGNORE_TLS_ERRORS
  const { ciphertext, nonce } = encrypt(String(ignoreTlsErrors))
  await platformDb().insert(tenantSecrets).values({
    tenantId, provider: 'smtp', key, valueEncrypted: ciphertext, nonce, status: 'active', createdBy: null,
  }).onConflictDoUpdate({
    target: [tenantSecrets.tenantId, tenantSecrets.provider, tenantSecrets.key],
    set: { valueEncrypted: ciphertext, nonce, status: 'active', updatedAt: new Date() },
  })
  await recordPlatformAudit(actor, { action: 'tenant.smtp_ignore_tls_errors', tenantId, entity: 'tenant_secret', after: { ignoreTlsErrors } })
}

/** Читання того самого прапорця (для екрана оператора): звичайний `getSecret` — читання не потребує BYPASSRLS. */
export async function getSmtpIgnoreTlsErrors(tenantId: string): Promise<boolean> {
  const { getSecret, SECRET_KEYS } = await import('./secrets')
  return (await getSecret(tenantId, 'smtp', SECRET_KEYS.smtp.IGNORE_TLS_ERRORS)) === 'true'
}

// ── Purge ─────────────────────────────────────────────────────────────

export interface PurgeReport {
  tenantId: string
  slug: string
  tables: Record<string, number>
  passes: number
  s3: { deleted: number, error: string | null }
  durationMs: number
}

const BATCH = 5000

/** Таблицы с tenant_id (docs/25 §3.1) — всё, что принадлежит тенанту. */
async function tenantTables(): Promise<string[]> {
  const rows = await platformDb().execute(sql`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname`) as unknown as { t: string }[]
  return rows.map(r => r.t)
}

async function deleteS3Prefix(prefix: string): Promise<{ deleted: number, error: string | null }> {
  try {
    const { s3, S3_BUCKET } = await import('./media')
    const client = s3()
    let deleted = 0
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET(), Prefix: prefix, ContinuationToken: token }))
      const keys = (page.Contents ?? []).map(o => ({ Key: o.Key! }))
      if (keys.length) {
        await client.send(new DeleteObjectsCommand({ Bucket: S3_BUCKET(), Delete: { Objects: keys, Quiet: true } }))
        deleted += keys.length
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return { deleted, error: null }
  }
  catch (err) {
    return { deleted: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Необратимое удаление данных тенанта (docs/25 §8): партиями по BATCH строк, таблицы — в порядке зависимостей
 * (таблица, которую ещё держит внешний ключ, откладывается на следующий проход), затем строка `tenants`,
 * затем S3-префикс `t/<tenant_id>/`. Отчёт — в `platform_audit` (`tenant.purged`, subject_tenant_id уже null).
 */
export async function purgeTenantData(tenantId: string, actor: PlatformAuth | null = null): Promise<PurgeReport> {
  const started = Date.now()
  const db = platformDb()
  const t = await loadTenant(tenantId)
  if (!t) throw new Error(`tenant ${tenantId} не найден`)
  const tables: Record<string, number> = {}
  let pending = await tenantTables()
  let passes = 0
  while (pending.length && passes < 20) {
    passes++
    const next: string[] = []
    for (const table of pending) {
      try {
        let total = tables[table] ?? 0
        for (;;) {
          const rows = await db.execute(sql`
            with del as (delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where tenant_id = ${tenantId}::uuid limit ${BATCH}) returning 1)
            select count(*)::int as n from del`) as unknown as { n: number }[]
          const n = rows[0]?.n ?? 0
          total += n
          if (n < BATCH) break
        }
        tables[table] = total
      }
      catch (err) {
        // 23503 foreign_key_violation: ещё держит другая таблица — вернёмся после неё
        if ((err as { code?: string }).code === '23503' || String(err).includes('violates foreign key')) next.push(table)
        else throw err
      }
    }
    if (next.length === pending.length) throw new Error(`tenant.purge: не удаётся удалить ${next.join(', ')} — циклические внешние ключи`)
    pending = next
  }
  if (pending.length) throw new Error(`tenant.purge: остались таблицы ${pending.join(', ')}`)
  await db.delete(tenants).where(eq(tenants.id, tenantId))
  const s3 = await deleteS3Prefix(`t/${tenantId}/`)
  invalidateTenant(tenantId)
  invalidateLimits(tenantId)
  const report: PurgeReport = { tenantId, slug: t.slug, tables: Object.fromEntries(Object.entries(tables).filter(([, n]) => n > 0)), passes, s3, durationMs: Date.now() - started }
  await db.insert(platformAudit).values({
    adminId: actor?.adminId ?? null, adminEmail: actor?.email ?? 'worker', action: 'tenant.purged', subjectTenantId: null,
    entity: 'tenant', entityId: tenantId, before: { slug: t.slug, name: t.name, archivedAt: t.archivedAt }, after: report, requestContext: currentRequestContext(),
  })
  return report
}

/**
 * Обработчик задачи `tenant.purge`: исполняет только если тенант всё ещё archived и срок вышел —
 * отменённый purge (archived_at = null, статус suspended) просто не сработает.
 */
export async function runTenantPurge(tenantId: string): Promise<{ purged: boolean, reason?: string, report?: PurgeReport }> {
  const t = await loadTenant(tenantId)
  if (!t) return { purged: false, reason: 'not_found' }
  if (t.status !== 'archived' || !t.archivedAt) return { purged: false, reason: 'not_archived' }
  if (purgeAtOf(t.archivedAt)!.getTime() > Date.now()) return { purged: false, reason: 'too_early' }
  return { purged: true, report: await purgeTenantData(tenantId) }
}
