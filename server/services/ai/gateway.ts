import { randomUUID } from 'node:crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { and, desc, eq, sql } from 'drizzle-orm'
import { aiCalls, aiProviders, mediaAssets } from '../../db/schema'
import { ensureAiProviders } from '../../db/tenantDefaults'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { currentRequestContext } from '../../utils/requestContext'
import type { AiCallRefKind, AiDriver, AiPurpose, AiUsageAxis } from '../../../shared/enums'
import { effectiveLimits, type LimitCheck } from '../tenantLimits'
import { AXIS_METER, applyUsageTx, meterOrDegrade, prepareUsage, recordUsage, settleUsage, type AxisDegradation } from '../usageCounters'
import { syncNotice } from '../limitNotices'
import { readRefSecret } from '../secrets'
import { enqueueNotification, tenantAdminIds } from '../notifications'
import { embeddingOverride } from '../embeddings'
import { S3_BUCKET, ensureBucket, s3 } from '../media'
import { runDriver, type DriverResult } from './drivers'
import { AI_PURPOSE_METER, aiUnavailable, buildChain, canonicalJson, digestOf, idempotencyKey, normalizeEndpoint, sha256Hex, type AiUnavailableReason } from './policy'
import type { EmbedInput, EmbedOutput, PromptDef } from './prompts'

/**
 * Шлюз модели — **единственная точка вызова модели в продукте** (`docs/v2/30` §3.2, §7.12,
 * §7.16, §7.18; `docs/v2/35` §7.1, §7.7; план `45` PR-27). Генерация вакансии (PR-17),
 * эмбеддинги библиотеки и базы знаний (PR-25) и будущие собеседование, подсказка и Підсумок
 * (PR-28, PR-29) идут сюда; драйверы (`drivers.ts`) и HTTP эмбеддингов (`embeddings.ts`)
 * снаружи этого каталога не вызываются (сквозная проверка 15 `scripts/v2-crosschecks.sh`).
 *
 * Что делает шлюз на каждый вызов, по порядку:
 * 1. **Журнал.** Каждый вызов — строка `ai_calls`: модель, версия промпта, дайджест входа,
 *    выход, задержка, токены, статус; отказ и деградация — тоже строка (`refused`/`degraded`).
 * 2. **Подписка и ось.** Тарифицируемая операция (`per_call`) при истёкшем или выключенном ИИ,
 *    в `readonly`/`suspended` не выполняется (`35` §7.7 п. 4, §7.8 п. 4); при исчерпанной оси —
 *    не выполняется и поднимает предупреждение админам (`limit_exceeded` с `axis`, `44` В-16).
 *    Жёсткая ось даёт `refused`, ось «жёсткий с деградацией» — `degraded`: операция идёт дальше
 *    без ИИ (ИИ-сверка → ручная проверка, `35` §7.1).
 * 3. **Идемпотентность.** Повтор с тем же ключом (`30` §7.18) и тем же входом отдаёт
 *    сохранённый выход и не тратит лимит.
 * 4. **Профиль и запасной.** Основной профиль роли, при отказе — его запасные (`30` §7.12);
 *    каждый отказ провайдера — своя строка журнала; пять отказов подряд — `ai_provider_down`.
 * 5. **Списание.** Успешный тарифицируемый вызов отмечается `billed`, операция списывается и
 *    результат сохраняется **одной транзакцией** (`persist`): упавший вызов ничего не списывает
 *    (`35` §12, §13 к. 9), а несохранённый результат — тоже.
 *
 * **ИИ не принимает решений о людях** (инвариант 18): шлюз возвращает выход модели вызывающему
 * и ничего не пишет в сущности сам — решение делает человек, а запись — сервис-владелец.
 */

export interface AiCtx {
  tenantId: string
  /** Кто инициировал вызов; `null` — фоновая задача. */
  actorId: string | null
}

export interface AiRef { kind: AiCallRefKind, id: string | null }

export interface ModelInfo {
  providerId: string | null
  driver: AiDriver | null
  modelName: string
  modelVersion: string | null
  /** `id` подменённого в тестах провайдера эмбеддингов (`setEmbeddingProvider`), иначе пусто. */
  overrideId?: string
}

export interface CallOptions<O> {
  ref: AiRef
  /** О ком вызов (для обезличивания, `30` §7.9); у генерации и эмбеддинга — пусто. */
  subjectUserId?: string | null
  tryNo?: number
  /** Списывать ли операцию оси этим вызовом; по умолчанию — да у `per_call`, нет у остальных. */
  charge?: boolean
  /** `false` — профиль-заглушка не годится (база знаний без колонки модели, `knowledge.ts`). */
  acceptStub?: boolean
  /** `usage_events.ref_id`, если отличается от `ref.id`. */
  usageRefId?: string | null
  /**
   * Сохранение результата **в той же транзакции**, что и отметка вызова и списание. Исключение
   * откатывает всё трое: вызов остаётся `failed` с `persist_failed`, операция не списана.
   */
  persist?: (tx: TenantTx, output: O, call: { callId: number, model: ModelInfo }) => Promise<void>
}

export type AiFailCode = 'limit_exceeded' | 'ai_unavailable' | 'no_provider' | 'stub_not_accepted' | 'provider_failed'

export type CallResult<O>
  = | { ok: true, output: O, callId: number, cached: boolean, model: ModelInfo }
    | {
      ok: false
      status: 'refused' | 'degraded' | 'failed' | 'timeout'
      code: AiFailCode
      callId: number | null
      /** Состояние оси при `limit_exceeded` — для `409 limit_exceeded` с `details.axis`. */
      check?: LimitCheck
      /** Чем заменяется операция при исчерпании оси (`35` §7.1). */
      degradation?: AxisDegradation | null
      reason?: AiUnavailableReason
      /** Последний код отказа провайдера при `provider_failed` (`http_error`, `timeout`, `bad_output`…). */
      providerError?: string
    }

// ── Профили ─────────────────────────────────────────────────────────────────────────────

type ProfileRow = typeof aiProviders.$inferSelect

interface ChainEntry {
  id: string
  code: string
  name: string
  purpose: AiPurpose
  driver: AiDriver
  endpointUrl: string | null
  secretRef: string | null
  modelName: string
  modelVersion: string | null
  params: { temperature?: number, maxTokens?: number }
  maxLatencyMs: number
  isActive: boolean
  priority: number
  fallbackProviderId: string | null
}

function toEntry(r: ProfileRow): ChainEntry {
  const params = (r.params ?? {}) as { temperature?: unknown, maxTokens?: unknown }
  return {
    id: r.id, code: r.code, name: r.name, purpose: r.purpose as AiPurpose, driver: r.driver as AiDriver,
    endpointUrl: r.endpointUrl, secretRef: r.secretRef, modelName: r.modelName, modelVersion: r.modelVersion,
    params: {
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === 'number' ? { maxTokens: params.maxTokens } : {}),
    },
    maxLatencyMs: r.maxLatencyMs, isActive: r.isActive, priority: r.priority, fallbackProviderId: r.fallbackProviderId,
  }
}

/**
 * Профили тенанта; если у роли нет ни одного — досевает профили платформы (`ensureAiProviders`):
 * тенант, заведённый до PR-27, получает заглушки при первом же вызове.
 */
async function loadProfiles(tenantId: string, purpose: AiPurpose): Promise<ChainEntry[]> {
  return withTenant(tenantId, null, async (tx) => {
    let rows = await tx.select().from(aiProviders)
    if (!rows.some(r => r.purpose === purpose)) {
      await ensureAiProviders(tx, tenantId)
      rows = await tx.select().from(aiProviders)
    }
    return rows.map(toEntry)
  })
}

/** Цепочка профилей роли: основной и его запасные (`policy.ts#buildChain`). */
export async function resolveChain(tenantId: string, purpose: AiPurpose): Promise<ChainEntry[]> {
  return buildChain(await loadProfiles(tenantId, purpose), purpose)
}

// ── Ключ провайдера ─────────────────────────────────────────────────────────────────────

/**
 * Подключение платформы — адрес и ключ из окружения (в репозитории — только имена,
 * `.env.example`). Эмбеддинги — отдельной парой: поиск и генерацию платформа вправе вести у
 * разных вендоров.
 */
const PLATFORM_CONNECTION = {
  embed: { urlEnv: 'EMBEDDINGS_URL', keyEnv: 'EMBEDDINGS_API_KEY' },
  model: { urlEnv: 'AI_PROVIDER_URL', keyEnv: 'AI_PROVIDER_API_KEY' },
} as const

function platformEndpoint(purpose: AiPurpose): string | null {
  const conn = purpose === 'embed' ? PLATFORM_CONNECTION.embed : PLATFORM_CONNECTION.model
  // `EMBEDDINGS_URL` до PR-27 был полным адресом метода (`…/v1/embeddings`) — принимаем оба вида
  return normalizeEndpoint((process.env[conn.urlEnv] ?? '').replace(/\/embeddings\/?$/, ''))
}

/**
 * Ключ вызова: свой ключ тенанта (`secret_ref`, зашифрован `secrets.ts`) или ключ платформы.
 * **Ключ платформы уходит только на адрес платформы**: профиль, который тенант перенаправил на
 * свой адрес, без своего ключа идёт без авторизации — иначе форма профиля выдала бы наш ключ
 * любому серверу, чей адрес в неё впишут.
 */
async function apiKeyFor(tenantId: string, p: ChainEntry): Promise<string | null> {
  if (p.driver === 'stub') return null
  if (p.secretRef) {
    const ref = p.secretRef
    return withTenant(tenantId, null, tx => readRefSecret(tx, ref))
  }
  const platform = platformEndpoint(p.purpose)
  if (!platform || normalizeEndpoint(p.endpointUrl) !== platform) return null
  const conn = p.purpose === 'embed' ? PLATFORM_CONNECTION.embed : PLATFORM_CONNECTION.model
  return process.env[conn.keyEnv] || null
}

// ── Журнал ──────────────────────────────────────────────────────────────────────────────

interface CallBase {
  purpose: AiPurpose
  promptKey: string
  promptVersion: string
  ref: AiRef
  subjectUserId: string | null
  inputDigest: string
  /** Ключ полного входа в S3 (`30` §3.2): свой файл `ai_artifact` или объект, который уже есть. */
  inputRef?: string | null
  usageAxis: AiUsageAxis | null
  tryNo: number
}

function modelOf(p: ChainEntry | undefined): ModelInfo {
  return p
    ? { providerId: p.id, driver: p.driver, modelName: p.modelName, modelVersion: p.modelVersion }
    : { providerId: null, driver: null, modelName: 'none', modelVersion: null }
}

async function insertCall(ctx: AiCtx, base: CallBase, model: ModelInfo, status: string, extra: { errorCode?: string, finished?: boolean } = {}): Promise<number> {
  const [row] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.insert(aiCalls).values({
    tenantId: ctx.tenantId,
    providerId: model.providerId,
    purpose: base.purpose,
    promptKey: base.promptKey,
    promptVersion: base.promptVersion,
    modelName: model.modelName,
    modelVersion: model.modelVersion,
    refKind: base.ref.kind,
    refId: base.ref.id,
    subjectUserId: base.subjectUserId,
    actorUserId: ctx.actorId,
    inputDigest: base.inputDigest,
    inputRef: base.inputRef ?? null,
    status,
    errorCode: extra.errorCode ?? null,
    usageAxis: base.usageAxis,
    tryNo: base.tryNo,
    requestContext: currentRequestContext(),
    ...(extra.finished ? { finishedAt: new Date(), latencyMs: 0 } : {}),
  }).returning({ id: aiCalls.id }))
  return row!.id
}

async function finishFailed(ctx: AiCtx, callId: number, r: Extract<DriverResult, { ok: false }>, latencyMs: number, errorCode = r.errorCode): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.update(aiCalls).set({
    status: r.status, errorCode, httpStatus: r.httpStatus, latencyMs, finishedAt: new Date(),
  }).where(eq(aiCalls.id, callId)))
}

/** Сохранённый успешный вызов с тем же ключом идемпотентности и тем же входом (`30` §7.18). */
async function cachedCall(ctx: AiCtx, base: CallBase & { ref: { kind: AiCallRefKind, id: string } }): Promise<{ id: number, output: unknown, providerId: string | null, modelName: string, modelVersion: string | null } | null> {
  const [row] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({
    id: aiCalls.id, output: aiCalls.output, providerId: aiCalls.providerId, modelName: aiCalls.modelName, modelVersion: aiCalls.modelVersion,
  }).from(aiCalls).where(and(
    eq(aiCalls.refKind, base.ref.kind),
    eq(aiCalls.refId, base.ref.id),
    eq(aiCalls.promptKey, base.promptKey),
    eq(aiCalls.promptVersion, base.promptVersion),
    eq(aiCalls.tryNo, base.tryNo),
    eq(aiCalls.inputDigest, base.inputDigest),
    eq(aiCalls.status, 'ok'),
  )).orderBy(desc(aiCalls.id)).limit(1))
  return row ?? null
}

// ── Провайдер недоступен (`30` §8 `ai.provider_down`) ────────────────────────────────────

/** Сколько отказов подряд у одного профиля поднимают уведомление админам (`30` §8). */
export const AI_PROVIDER_DOWN_STREAK = 5

async function checkProviderDown(ctx: AiCtx, p: ChainEntry): Promise<void> {
  await withTenant(ctx.tenantId, null, async (tx) => {
    const last = await tx.select({ status: aiCalls.status }).from(aiCalls)
      .where(and(eq(aiCalls.providerId, p.id), sql`${aiCalls.status} in ('ok', 'failed', 'timeout')`))
      .orderBy(desc(aiCalls.createdAt), desc(aiCalls.id)).limit(AI_PROVIDER_DOWN_STREAK)
    if (last.length < AI_PROVIDER_DOWN_STREAK || last.some(r => r.status === 'ok')) return
    // Раз в сутки на профиль и человека: провайдер, лежащий весь день, не шлёт письмо на каждый вызов
    const day = new Date().toISOString().slice(0, 10)
    for (const userId of await tenantAdminIds(tx, ctx.tenantId)) {
      await enqueueNotification(tx, {
        tenantId: ctx.tenantId, userId, code: 'ai_provider_down',
        payload: { provider: p.name, purpose: p.purpose, n: AI_PROVIDER_DOWN_STREAK },
        dedupKey: `ai_provider_down:${p.id}:${day}:${userId}`,
      })
    }
  })
}

// ── Полный вход в S3 (`30` §3.2, §7.7; PR-28) ─────────────────────────────────────────

/**
 * Полный вход вызова — файлом в S3, в БД только дайджест и ключ (`30` §3.2 [решение]: иначе журнал
 * стал бы второй копией ПД кандидата, которую забудут стереть при обезличивании). Файл
 * регистрируется строкой `media_assets` с `origin = 'ai_artifact'` и владельцем — тем, о ком
 * вызов: так его видит хранилище (квота и разбивка по происхождению — один реестр, `34` §7.1), а
 * обезличивание и отзыв согласия находят и стирают его вместе с остальными записями человека.
 * Живёт 90 дней: `ai.calls_cleanup` обнуляет ссылку и отправляет файл в корзину с немедленной
 * очисткой. Квота хранилища здесь не проверяется: это журнал системы, а не загрузка человека,
 * и отказ записать вход не должен останавливать собеседование (`25` §10).
 *
 * Сбой записи не роняет вызов: модель всё равно вызывается, в журнале остаётся дайджест входа.
 */
async function storeCallInput(ctx: AiCtx, base: CallBase, input: unknown): Promise<string | null> {
  const body = Buffer.from(canonicalJson(input), 'utf8')
  const now = new Date()
  const key = `t/${ctx.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/ai-input-${randomUUID()}.json`
  try {
    await ensureBucket()
    await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: body, ContentType: 'application/json' }))
    await withTenant(ctx.tenantId, ctx.actorId, tx => tx.insert(mediaAssets).values({
      tenantId: ctx.tenantId,
      key,
      originalName: `ai-input-${base.promptKey}.json`,
      kind: 'file',
      mime: 'application/json',
      bytes: body.length,
      status: 'ready',
      ownerUserId: base.subjectUserId ?? ctx.actorId,
      origin: 'ai_artifact',
      sourceEntity: 'ai_calls',
      isEvidence: false,
    }))
    return key
  }
  catch (err) {
    console.error('[ai.input_ref]', err)
    return null
  }
}

// ── Вызов ───────────────────────────────────────────────────────────────────────────────

async function runProfile(ctx: AiCtx, p: ChainEntry, prompt: PromptDef<unknown, unknown>, input: unknown, key: string): Promise<DriverResult & { overrideId?: string }> {
  // Подмена провайдера эмбеддингов в тестах (`setEmbeddingProvider`): журнал и учёт те же
  if (prompt.purpose === 'embed') {
    const ov = embeddingOverride((input as EmbedInput).dims)
    if (ov) return { ok: true, output: await ov.embed((input as EmbedInput).texts), tokensIn: null, tokensOut: null, httpStatus: null, overrideId: ov.id }
  }
  return runDriver({
    profile: p,
    prompt,
    input,
    apiKey: await apiKeyFor(ctx.tenantId, p),
    idempotencyKey: key,
    signal: AbortSignal.timeout(p.maxLatencyMs),
  })
}

/**
 * Вызвать модель промптом `prompt` на входе `input`. Возвращает выход модели — или причину, по
 * которой вызова не было (`refused`/`degraded`) или он не удался (`failed`/`timeout`). Отказ
 * провайдера — не исключение: вызывающий решает, что показать человеку. Исключение — только
 * ошибка программы или `persist`.
 */
export async function callModel<I, O>(ctx: AiCtx, prompt: PromptDef<I, O>, input: I, opts: CallOptions<O>): Promise<CallResult<O>> {
  const meter = AI_PURPOSE_METER[prompt.purpose]
  const axis = meter.axis
  const charge = (opts.charge ?? meter.charge === 'per_call') && axis !== null
  const base: CallBase = {
    purpose: prompt.purpose, promptKey: prompt.key, promptVersion: prompt.version, ref: opts.ref,
    subjectUserId: opts.subjectUserId ?? null, inputDigest: digestOf(input), usageAxis: axis, tryNo: opts.tryNo ?? 1,
  }

  let chain = await resolveChain(ctx.tenantId, prompt.purpose)
  if (opts.acceptStub === false) {
    chain = chain.filter(p => p.driver !== 'stub')
    // Годного профиля нет — вызова нет и строки журнала тоже: модель ничего не видела
    if (!chain.length) return { ok: false, status: 'refused', code: 'stub_not_accepted', callId: null }
  }

  const cacheRef = opts.ref.id
  if (cacheRef && prompt.cacheable !== false) {
    const hit = await cachedCall(ctx, { ...base, ref: { kind: opts.ref.kind, id: cacheRef } })
    if (hit) {
      const p = chain.find(c => c.id === hit.providerId)
      return {
        ok: true, output: hit.output as O, callId: hit.id, cached: true,
        model: { providerId: hit.providerId, driver: p?.driver ?? null, modelName: hit.modelName, modelVersion: hit.modelVersion },
      }
    }
  }

  // Подписка и ось — только у операции, которая тарифицируется этим вызовом
  if (charge && axis) {
    const degradedAxis = AXIS_METER[axis].kind === 'hard_degraded'
    const reason = aiUnavailable((await effectiveLimits(ctx.tenantId)).subscription)
    if (reason) {
      const status = degradedAxis ? 'degraded' : 'refused'
      const callId = await insertCall(ctx, base, modelOf(chain[0]), status, { errorCode: 'ai_unavailable', finished: true })
      return { ok: false, status, code: 'ai_unavailable', callId, reason, degradation: degradedAxis ? AXIS_METER[axis].onExhausted : null }
    }
    const m = await meterOrDegrade(ctx.tenantId, axis)
    if (!m.state.ok) {
      const status = m.allowed ? 'degraded' : 'refused'
      const callId = await insertCall(ctx, base, modelOf(chain[0]), status, { errorCode: 'limit_exceeded', finished: true })
      // «Админу ушло ai_ops_exhausted» (`30` §13 к. 7) = `limit_exceeded` с `axis` (`44` В-16);
      // уже открытое предупреждение второй раз не шлётся — дедупликация `limitNotices.ts`.
      // `[fix-night-debts §3]` +1 — эта самая попытка: при лимите оси 0 запись блокируется до
      // счётчика (`recordUsage` ниже не вызывается), и `m.state.used` навсегда остаётся 0 —
      // без +1 `syncNotice`/`levelOf` не отличили бы «была попытка» от «ось никто не трогал».
      await syncNotice(ctx.tenantId, axis, m.state.used + 1, m.state.limit)
      return { ok: false, status, code: 'limit_exceeded', callId, check: m.state, degradation: m.degradation }
    }
  }

  if (!chain.length) {
    const callId = await insertCall(ctx, base, modelOf(undefined), 'refused', { errorCode: 'no_provider', finished: true })
    return { ok: false, status: 'refused', code: 'no_provider', callId }
  }

  const key = cacheRef
    ? idempotencyKey({ tenantId: ctx.tenantId, refKind: opts.ref.kind, refId: cacheRef, promptKey: prompt.key, promptVersion: prompt.version, tryNo: base.tryNo })
    : sha256Hex(randomUUID())
  // Вход — один на все профили цепочки: запасной видит ровно то же, что основной
  base.inputRef = prompt.inputRef ? prompt.inputRef(input) : prompt.storeInput ? await storeCallInput(ctx, base, input) : null
  let lastFail: { status: 'failed' | 'timeout', errorCode: string, callId: number } | null = null

  for (const p of chain) {
    const model = modelOf(p)
    const callId = await insertCall(ctx, base, model, 'running')
    const started = performance.now()
    const r = await runProfile(ctx, p, prompt as PromptDef<unknown, unknown>, input, key)
    const latencyMs = Math.round(performance.now() - started)

    if (!r.ok) {
      await finishFailed(ctx, callId, r, latencyMs)
      await checkProviderDown(ctx, p).catch(err => console.error('[ai.provider_down]', err))
      lastFail = { status: r.status, errorCode: r.errorCode, callId }
      continue
    }

    const output = r.output as O
    const info: ModelInfo = r.overrideId ? { ...model, overrideId: r.overrideId } : model
    const journal = prompt.journal ? prompt.journal(output) : output
    const prep = charge && axis ? await prepareUsage(ctx.tenantId, axis) : null
    let used: number | null = null
    try {
      await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
        await tx.update(aiCalls).set({
          status: 'ok', output: journal as object, outputDigest: digestOf(output), tokensIn: r.tokensIn, tokensOut: r.tokensOut,
          httpStatus: r.httpStatus, latencyMs, finishedAt: new Date(), billed: prep !== null,
        }).where(eq(aiCalls.id, callId))
        if (prep && axis) {
          used = await applyUsageTx(tx, ctx.tenantId, axis, 1, {
            refKind: AXIS_METER[axis].refKind ?? undefined,
            refId: opts.usageRefId ?? opts.ref.id,
            actorUserId: ctx.actorId,
            meta: { aiCallId: callId, promptKey: prompt.key },
          }, prep)
        }
        if (opts.persist) await opts.persist(tx, output, { callId, model: info })
      })
    }
    catch (err) {
      await finishFailed(ctx, callId, { ok: false, status: 'failed', errorCode: 'persist_failed', httpStatus: r.httpStatus }, latencyMs)
      throw err
    }
    if (prep && axis && used !== null) await settleUsage(ctx.tenantId, axis, used, prep.limit)
    return { ok: true, output, callId, cached: false, model: info }
  }

  return { ok: false, status: lastFail!.status, code: 'provider_failed', callId: lastFail!.callId, providerError: lastFail!.errorCode }
}

// ── Операция «один раз за сессию» (`30` §7.12) ──────────────────────────────────────────

export type ReserveResult
  = | { ok: true, reserved: boolean }
    | { ok: false, code: 'ai_unavailable', reason: AiUnavailableReason }
    | { ok: false, code: 'limit_exceeded', check: LimitCheck, degradation: AxisDegradation | null }

/**
 * Резерв операции оси, которая тратится **сессией**, а не вызовом (`ai_interview_ops`, `30`
 * §7.12 [решение]): «резервируется при переходе в `in_progress` и списывается один раз за
 * сессию». Вызовы внутри сессии (расшифровка, оценка, Підсумок и их повторы после сбоев) идут
 * через `callModel()` без списания — тенант не платит дважды за наш сбой.
 *
 * Отказ — `limit_exceeded` с `degradation = 'finish_started'` (`35` §7.1: новые не запускаются,
 * начатые доводятся) или `ai_unavailable`: сессия не стартует, вызывающий ведёт кандидата по
 * `alternative_path`, счётчик не меняется, админам уходит `limit_exceeded` с `axis`
 * (`30` §13 к. 7). Повторный резерв той же сессии — не второе списание (`reserved: false`).
 */
export async function reserveSessionOp(ctx: AiCtx, axis: AiUsageAxis, ref: { kind: AiCallRefKind, id: string }): Promise<ReserveResult> {
  if (!Object.values(AI_PURPOSE_METER).some(m => m.axis === axis && m.charge === 'per_session')) {
    throw new Error(`reserveSessionOp: ось ${axis} тратится вызовом, а не сессией`)
  }
  const reason = aiUnavailable((await effectiveLimits(ctx.tenantId)).subscription)
  if (reason) return { ok: false, code: 'ai_unavailable', reason }

  const refKind = AXIS_METER[axis].refKind!
  // Резерв считается по сумме строк расхода сессии: снятый резерв (`releaseSessionOp`) — уже не резерв
  if (await sessionNet(ctx, axis, refKind, ref.id) > 0) return { ok: true, reserved: false }

  const m = await meterOrDegrade(ctx.tenantId, axis)
  if (!m.state.ok) {
    // `[fix-night-debts §3]` +1 — та же самая причина, что в `callModel()` выше: при лимите
    // оси 0 счётчик не растёт (резерв не состоялся), `used` без поправки навсегда 0.
    await syncNotice(ctx.tenantId, axis, m.state.used + 1, m.state.limit)
    return { ok: false, code: 'limit_exceeded', check: m.state, degradation: m.degradation }
  }
  await recordUsage(ctx.tenantId, axis, 1, { refKind, refId: ref.id, actorUserId: ctx.actorId, meta: { reservedFor: ref.kind } })
  return { ok: true, reserved: true }
}

async function sessionNet(ctx: AiCtx, axis: AiUsageAxis, refKind: string, refId: string): Promise<number> {
  const [row] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select coalesce(sum(delta), 0)::int as net from usage_events
     where axis = ${axis} and ref_kind = ${refKind} and ref_id = ${refId}::uuid`) as unknown as Promise<{ net: number }[]>)
  return Number(row?.net ?? 0)
}

/**
 * Снять резерв сессии (`30` §12 п. 1, §7.12 [решение]; хвост PR-27): сессия закончилась, не
 * получив ни одного ответа, — ИИ не сделал для тенанта ничего, и операция возвращается строкой
 * расхода с `delta = -1`. Идемпотентно: снимается только то, что зарезервировано и ещё не снято.
 * Возвращает, было ли что снимать.
 */
export async function releaseSessionOp(ctx: AiCtx, axis: AiUsageAxis, ref: { kind: AiCallRefKind, id: string }, reason: string): Promise<boolean> {
  const refKind = AXIS_METER[axis].refKind!
  if (await sessionNet(ctx, axis, refKind, ref.id) <= 0) return false
  await recordUsage(ctx.tenantId, axis, -1, { refKind, refId: ref.id, actorUserId: ctx.actorId, meta: { releasedFor: ref.kind, reason } })
  return true
}

// ── Эмбеддинги ──────────────────────────────────────────────────────────────────────────

/** Метка модели рядом с вектором: `driver:model:dims` (`library_modules.embedding_model`). */
function embedModelTag(m: ModelInfo, dims: number): string {
  return m.overrideId ?? `${m.driver ?? 'none'}:${m.modelName}:${dims}`
}

/**
 * Метка модели, которой **сейчас** считались бы векторы этой размерности, — без вызова модели.
 * По ней `library.embedding_refresh` находит строки чужой модели; `null` — у роли `embed` нет
 * активного профиля, векторы считать нечем.
 */
export async function embedModelId(tenantId: string, dims: number): Promise<string | null> {
  const ov = embeddingOverride(dims)
  if (ov) return ov.id
  const [primary] = await resolveChain(tenantId, 'embed')
  return primary ? `${primary.driver}:${primary.modelName}:${dims}` : null
}

export type EmbedResult
  = | { ok: true, vectors: (number[] | null)[], model: string, callId: number }
    | { ok: false, code: AiFailCode, callId: number | null }

/**
 * Векторы текстов через шлюз: одна строка `ai_calls` на запрос к провайдеру, роль `embed` вне
 * тарифа (`policy.ts`). Метка модели — того профиля, который реально ответил: при уходе на
 * запасной векторы помечаются его меткой, и следующий пересчёт найдёт их как «чужую модель».
 */
export async function embedTexts(ctx: AiCtx, req: { prompt: PromptDef<EmbedInput, EmbedOutput>, texts: string[], dims: number, ref: AiRef, acceptStub?: boolean }): Promise<EmbedResult> {
  const r = await callModel(ctx, req.prompt, { texts: req.texts, dims: req.dims }, { ref: req.ref, acceptStub: req.acceptStub })
  if (!r.ok) return { ok: false, code: r.code, callId: r.callId }
  return { ok: true, vectors: r.output, model: embedModelTag(r.model, req.dims), callId: r.callId }
}
