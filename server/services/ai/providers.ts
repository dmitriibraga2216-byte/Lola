import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { aiProviders } from '../../db/schema'
import { ensureAiProviders } from '../../db/tenantDefaults'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { AI_PURPOSES, type AiDataRegion, type AiDriver, type AiProviderRetention, type AiPurpose } from '../../../shared/enums'
import type { AiProviderCreateInput, AiProviderUpdateInput } from '../../../shared/schemas/ai'
import { recordAudit } from '../audit'
import { dropRefSecret, putRefSecret } from '../secrets'
import { endpointAllowed, fallbackViolation, normalizeEndpoint, retentionForbidden, type FallbackViolation } from './policy'

/**
 * Профили поставщика модели тенанта (`docs/v2/30` §3.2, §10 `GET | PUT /ai/providers[/:id]`;
 * план `45` PR-27). Настраивает HR/админ (`30` §2) — скоуп `ai.audit` (`41` §2).
 *
 * **Условие выхода PR-27, сквозная проверка 18** (`42` §5, `30` §7.7): профиль с ролью
 * `transcribe` и `provider_retention = 'unknown'` не сохраняется — ни созданием, ни правкой
 * роли или срока, ни через цепочку запасных (у запасного та же роль, `policy.ts`). Отказ —
 * `422 provider.retention_unknown`; мимо сервиса его держит CHECK таблицы.
 *
 * Ключ тенанта принимается только на запись и хранится зашифрованной строкой `tenant_secrets`
 * (`secrets.ts#putRefSecret`); в ответах и в `audit_log` — только признак `hasOwnKey`.
 */

export interface ProviderCtx { tenantId: string, actorId: string }

export interface AiProviderCard {
  id: string
  code: string
  name: string
  purpose: AiPurpose
  driver: AiDriver
  endpointUrl: string | null
  hasOwnKey: boolean
  modelName: string
  modelVersion: string | null
  params: Record<string, unknown>
  dataRegion: AiDataRegion
  providerRetention: AiProviderRetention
  maxLatencyMs: number
  isActive: boolean
  priority: number
  fallbackProviderId: string | null
  updatedAt: string
  updatedBy: string | null
}

export type ProviderErrorCode
  = | 'not_found' | 'code_taken' | 'retention_unknown' | 'endpoint_required' | 'endpoint_invalid'
    | 'region_comment_required' | FallbackViolation

export type SaveProviderResult = { ok: true, provider: AiProviderCard } | { ok: false, code: ProviderErrorCode }

type Row = typeof aiProviders.$inferSelect

function cardOf(r: Row): AiProviderCard {
  return {
    id: r.id, code: r.code, name: r.name, purpose: r.purpose as AiPurpose, driver: r.driver as AiDriver,
    endpointUrl: r.endpointUrl, hasOwnKey: r.secretRef !== null, modelName: r.modelName, modelVersion: r.modelVersion,
    params: (r.params ?? {}) as Record<string, unknown>, dataRegion: r.dataRegion as AiDataRegion,
    providerRetention: r.providerRetention as AiProviderRetention, maxLatencyMs: r.maxLatencyMs, isActive: r.isActive,
    priority: r.priority, fallbackProviderId: r.fallbackProviderId, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy,
  }
}

/** Что из профиля попадает в `audit_log`: всё, кроме ссылки на секрет (есть ли ключ — да, какой — нет). */
function auditView(r: Row) {
  const { secretRef, createdAt: _c, updatedAt: _u, tenantId: _t, ...rest } = r
  return { ...rest, hasOwnKey: secretRef !== null }
}

async function allRows(tx: TenantTx, tenantId: string): Promise<Row[]> {
  let rows = await tx.select().from(aiProviders).orderBy(asc(aiProviders.purpose), asc(aiProviders.priority), asc(aiProviders.code))
  // Тенант, заведённый до PR-27 (или роль, добавленная позже), получает профили платформы сразу
  if (AI_PURPOSES.some(p => !rows.some(r => r.purpose === p))) {
    await ensureAiProviders(tx, tenantId)
    rows = await tx.select().from(aiProviders).orderBy(asc(aiProviders.purpose), asc(aiProviders.priority), asc(aiProviders.code))
  }
  return rows
}

export async function listProviders(ctx: ProviderCtx): Promise<AiProviderCard[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async tx => (await allRows(tx, ctx.tenantId)).map(cardOf))
}

/** Профиль тенанта; чужой под RLS не виден — `null`, ручка отвечает `404` (правило 15). */
export async function getProvider(ctx: ProviderCtx, id: string): Promise<AiProviderCard | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(aiProviders).where(eq(aiProviders.id, id))
    return row ? cardOf(row) : null
  })
}

interface Candidate {
  id: string
  purpose: AiPurpose
  driver: AiDriver
  endpointUrl: string | null
  dataRegion: AiDataRegion
  providerRetention: AiProviderRetention
  fallbackProviderId: string | null
}

/**
 * Смысловые правила профиля, по порядку важности:
 * 1. срок хранения у расшифровки (сквозная проверка 18) — первым: это условие выхода PR-27;
 * 2. адрес у сетевого драйвера и допустимость нового адреса (только `https`, не внутренняя сеть);
 * 3. комментарий при переводе в регион `other` (`30` §3.2);
 * 4. граф запасных: не сам на себя, та же роль, без циклов, не глубже двух.
 */
function validate(rows: readonly Row[], next: Candidate, prev: Row | null, input: { endpointUrl?: string | null, regionComment?: string }): ProviderErrorCode | null {
  if (retentionForbidden(next)) return 'retention_unknown'
  if (next.driver !== 'stub' && !normalizeEndpoint(next.endpointUrl)) return 'endpoint_required'
  const endpointChanged = input.endpointUrl !== undefined && normalizeEndpoint(input.endpointUrl) !== normalizeEndpoint(prev?.endpointUrl)
  if (endpointChanged && input.endpointUrl && !endpointAllowed(input.endpointUrl)) return 'endpoint_invalid'
  if (next.dataRegion === 'other' && prev?.dataRegion !== 'other' && !input.regionComment) return 'region_comment_required'
  const nodes = rows.map(r => ({ id: r.id, purpose: r.purpose as AiPurpose, fallbackProviderId: r.fallbackProviderId }))
  return fallbackViolation(nodes, { id: next.id, purpose: next.purpose, fallbackProviderId: next.fallbackProviderId })
}

/** Свой ключ профиля: строка `tenant_secrets` с ключом `ai_provider:<id>`, шифрование — `secrets.ts`. */
async function applyApiKey(tx: TenantTx, ctx: ProviderCtx, row: Row, apiKey: string | null | undefined): Promise<string | null> {
  if (apiKey === undefined) return row.secretRef
  if (apiKey === null) {
    if (row.secretRef) await dropRefSecret(tx, row.secretRef)
    return null
  }
  return putRefSecret(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, provider: 'ai', key: `ai_provider:${row.id}`, value: apiKey, label: row.name })
}

export async function createProvider(ctx: ProviderCtx, input: AiProviderCreateInput): Promise<SaveProviderResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await allRows(tx, ctx.tenantId)
    if (rows.some(r => r.code === input.code)) return { ok: false as const, code: 'code_taken' as const }
    const id = randomUUID()
    const next: Candidate = {
      id, purpose: input.purpose, driver: input.driver, endpointUrl: normalizeEndpoint(input.endpointUrl),
      dataRegion: input.dataRegion, providerRetention: input.providerRetention, fallbackProviderId: input.fallbackProviderId ?? null,
    }
    const bad = validate(rows, next, null, input)
    if (bad) return { ok: false as const, code: bad }

    const [created] = await tx.insert(aiProviders).values({
      id, tenantId: ctx.tenantId, code: input.code, name: input.name, purpose: input.purpose, driver: input.driver,
      endpointUrl: next.endpointUrl, modelName: input.modelName, modelVersion: input.modelVersion ?? null, params: input.params,
      dataRegion: input.dataRegion, providerRetention: input.providerRetention, maxLatencyMs: input.maxLatencyMs,
      isActive: input.isActive, priority: input.priority, fallbackProviderId: next.fallbackProviderId, updatedBy: ctx.actorId,
    }).returning()
    let row = created!
    const secretRef = await applyApiKey(tx, ctx, row, input.apiKey)
    if (secretRef) [row] = await tx.update(aiProviders).set({ secretRef }).where(eq(aiProviders.id, id)).returning() as [Row]

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'ai.provider.create', entity: 'ai_provider', entityId: id, after: auditView(row) })
    if (row.dataRegion === 'other') {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'ai.provider.region_other', entity: 'ai_provider', entityId: id, after: { code: row.code, comment: input.regionComment } })
    }
    return { ok: true as const, provider: cardOf(row) }
  })
}

export async function updateProvider(ctx: ProviderCtx, id: string, input: AiProviderUpdateInput): Promise<SaveProviderResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await allRows(tx, ctx.tenantId)
    const before = rows.find(r => r.id === id)
    if (!before) return { ok: false as const, code: 'not_found' as const }
    const next: Candidate = {
      id,
      purpose: input.purpose ?? before.purpose as AiPurpose,
      driver: input.driver ?? before.driver as AiDriver,
      endpointUrl: input.endpointUrl !== undefined ? normalizeEndpoint(input.endpointUrl) : before.endpointUrl,
      dataRegion: input.dataRegion ?? before.dataRegion as AiDataRegion,
      providerRetention: input.providerRetention ?? before.providerRetention as AiProviderRetention,
      fallbackProviderId: input.fallbackProviderId !== undefined ? input.fallbackProviderId : before.fallbackProviderId,
    }
    const bad = validate(rows, next, before, input)
    if (bad) return { ok: false as const, code: bad }

    const secretRef = await applyApiKey(tx, ctx, before, input.apiKey)
    const [after] = await tx.update(aiProviders).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
      ...(input.modelVersion !== undefined ? { modelVersion: input.modelVersion } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
      ...(input.maxLatencyMs !== undefined ? { maxLatencyMs: input.maxLatencyMs } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      purpose: next.purpose, driver: next.driver, endpointUrl: next.endpointUrl, dataRegion: next.dataRegion,
      providerRetention: next.providerRetention, fallbackProviderId: next.fallbackProviderId, secretRef,
      updatedBy: ctx.actorId, updatedAt: new Date(),
    }).where(eq(aiProviders.id, id)).returning()

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'ai.provider.update', entity: 'ai_provider', entityId: id, before: auditView(before), after: auditView(after!) })
    if (after!.dataRegion === 'other' && before.dataRegion !== 'other') {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'ai.provider.region_other', entity: 'ai_provider', entityId: id, after: { code: after!.code, comment: input.regionComment } })
    }
    return { ok: true as const, provider: cardOf(after!) }
  })
}
