import type { AiDriver, AiPurpose } from '../../../shared/enums'
import { requestEmbeddings } from '../embeddings'
import type { AnyPrompt, EmbedInput } from './prompts'

/**
 * Драйверы профиля (`ai_providers.driver`, `docs/v2/30` §3.2): как именно достучаться до модели.
 * Вызывающий код драйверов не знает — он зовёт шлюз (`gateway.ts`), шлюз выбирает профиль, а
 * профиль — драйвер. Смена вендора — правка строки профиля, не кода (`30` §3.2).
 *
 * - `stub` — детерминированная заглушка (`docs/v2/44` §8): ответ промпта `stub()`, без сети;
 * - `openai_compatible` — `POST {endpoint}/chat/completions` (ответ — JSON-объект) и
 *   `POST {endpoint}/embeddings`; `endpoint` — базовый адрес вида `https://…/v1`;
 * - `self_hosted` — тот же протокол на своём сервере модели, ключ не обязателен;
 * - `http_custom` — один `POST {endpoint}` с `{purpose, promptKey, promptVersion, model, input}`
 *   и ответом `{output, usage?}` — для прокси и сервисов, которые говорят не по OpenAI.
 *
 * Расшифровка (`transcribe`) по HTTP приезжает с собеседованием (PR-28): звук идёт из S3
 * multipart-запросом, которого до появления реплик не из чего собрать. Сейчас такой вызов у
 * сетевых драйверов честно падает `driver_unsupported`, а у заглушки — работает.
 */

export interface DriverProfile {
  id: string
  driver: AiDriver
  purpose: AiPurpose
  endpointUrl: string | null
  modelName: string
  params: { temperature?: number, maxTokens?: number }
}

export interface DriverRequest {
  profile: DriverProfile
  prompt: AnyPrompt
  input: unknown
  apiKey: string | null
  idempotencyKey: string
  signal: AbortSignal
}

export type DriverResult
  = | { ok: true, output: unknown, tokensIn: number | null, tokensOut: number | null, httpStatus: number | null }
    | { ok: false, status: 'failed' | 'timeout', errorCode: string, httpStatus: number | null }

// ── HTTP: подмена в тестах ──────────────────────────────────────────────────────────────

let httpImpl: typeof fetch | null = null

/** Подменить сетевой вызов драйверов (тесты): так проверяются отказ, таймаут и запасной профиль. */
export function setAiHttp(f: typeof fetch | null): void {
  httpImpl = f
}

const doFetch: typeof fetch = (input, init) => (httpImpl ?? fetch)(input, init)

function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  return name === 'TimeoutError' || name === 'AbortError'
}

function failed(errorCode: string, httpStatus: number | null = null): DriverResult {
  return { ok: false, status: 'failed', errorCode, httpStatus }
}

function headers(req: DriverRequest): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': req.idempotencyKey,
    ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
  }
}

/** Ответ модели — через `parse()` промпта: невалидный ответ — `bad_output`, а не данные в форме человека. */
function parsed(req: DriverRequest, raw: unknown, tokensIn: number | null, tokensOut: number | null, httpStatus: number): DriverResult {
  if (!req.prompt.parse) return failed('driver_unsupported', httpStatus)
  try {
    return { ok: true, output: req.prompt.parse(raw), tokensIn, tokensOut, httpStatus }
  }
  catch {
    return failed('bad_output', httpStatus)
  }
}

// ── Драйверы ────────────────────────────────────────────────────────────────────────────

async function runStub(req: DriverRequest): Promise<DriverResult> {
  return { ok: true, output: req.prompt.stub(req.input), tokensIn: null, tokensOut: null, httpStatus: null }
}

async function runOpenAi(req: DriverRequest): Promise<DriverResult> {
  const base = (req.profile.endpointUrl ?? '').replace(/\/+$/, '')
  if (!base) return failed('provider_not_configured')
  const { purpose } = req.profile
  if (purpose === 'transcribe') return failed('driver_unsupported')

  if (purpose === 'embed') {
    const input = req.input as EmbedInput
    const r = await requestEmbeddings({
      url: `${base}/embeddings`, key: req.apiKey ?? undefined, model: req.profile.modelName, dims: input.dims,
      fetchImpl: doFetch, idempotencyKey: req.idempotencyKey, signal: req.signal,
    }, input.texts)
    if (r.ok) return { ok: true, output: r.vectors, tokensIn: r.tokensIn, tokensOut: null, httpStatus: r.httpStatus }
    return r.errorCode === 'timeout'
      ? { ok: false, status: 'timeout', errorCode: 'timeout', httpStatus: null }
      : failed(r.errorCode, r.httpStatus)
  }

  const messages = req.prompt.chat?.(req.input)
  if (!messages) return failed('driver_unsupported')
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: headers(req),
      body: JSON.stringify({
        model: req.profile.modelName,
        messages,
        response_format: { type: 'json_object' },
        ...(req.profile.params.temperature !== undefined ? { temperature: req.profile.params.temperature } : {}),
        ...(req.profile.params.maxTokens !== undefined ? { max_tokens: req.profile.params.maxTokens } : {}),
      }),
      signal: req.signal,
    })
    if (!res.ok) return failed('http_error', res.status)
    const json = await res.json().catch(() => null) as { choices?: { message?: { content?: string } }[], usage?: { prompt_tokens?: number, completion_tokens?: number } } | null
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') return failed('bad_output', res.status)
    let raw: unknown
    try {
      raw = JSON.parse(content)
    }
    catch {
      return failed('bad_output', res.status)
    }
    return parsed(req, raw, json?.usage?.prompt_tokens ?? null, json?.usage?.completion_tokens ?? null, res.status)
  }
  catch (err) {
    return isTimeout(err) ? { ok: false, status: 'timeout', errorCode: 'timeout', httpStatus: null } : failed('network')
  }
}

async function runHttpCustom(req: DriverRequest): Promise<DriverResult> {
  const url = req.profile.endpointUrl
  if (!url) return failed('provider_not_configured')
  if (req.profile.purpose === 'transcribe') return failed('driver_unsupported')
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: headers(req),
      body: JSON.stringify({ purpose: req.profile.purpose, promptKey: req.prompt.key, promptVersion: req.prompt.version, model: req.profile.modelName, input: req.input }),
      signal: req.signal,
    })
    if (!res.ok) return failed('http_error', res.status)
    const json = await res.json().catch(() => null) as { output?: unknown, usage?: { tokensIn?: number, tokensOut?: number } } | null
    if (!json || json.output === undefined) return failed('bad_output', res.status)
    const tokensIn = json.usage?.tokensIn ?? null
    const tokensOut = json.usage?.tokensOut ?? null
    if (req.profile.purpose === 'embed') {
      const dims = (req.input as EmbedInput).dims
      const out = json.output
      if (!Array.isArray(out)) return failed('bad_output', res.status)
      return { ok: true, output: out.map(v => (Array.isArray(v) && v.length === dims ? v as number[] : null)), tokensIn, tokensOut, httpStatus: res.status }
    }
    return parsed(req, json.output, tokensIn, tokensOut, res.status)
  }
  catch (err) {
    return isTimeout(err) ? { ok: false, status: 'timeout', errorCode: 'timeout', httpStatus: null } : failed('network')
  }
}

const DRIVERS: Record<AiDriver, (req: DriverRequest) => Promise<DriverResult>> = {
  stub: runStub,
  openai_compatible: runOpenAi,
  self_hosted: runOpenAi,
  http_custom: runHttpCustom,
}

/** Выполнить запрос драйвером профиля. Исключение драйвера — тоже отказ провайдера, а не 500. */
export async function runDriver(req: DriverRequest): Promise<DriverResult> {
  try {
    return await DRIVERS[req.profile.driver](req)
  }
  catch (err) {
    return isTimeout(err) ? { ok: false, status: 'timeout', errorCode: 'timeout', httpStatus: null } : failed('driver_error')
  }
}
