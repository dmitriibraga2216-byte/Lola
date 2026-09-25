import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { AiDriver, AiPurpose } from '../../../shared/enums'
import { requestEmbeddings } from '../embeddings'
import { S3_BUCKET, s3 } from '../media'
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
 * Расшифровка (`transcribe`, PR-28) — не JSON, а файл: драйвер читает аудио реплики из S3 сам
 * (`prompt.audio`) и шлёт его multipart-запросом — `openai_compatible`/`self_hosted` на
 * `{endpoint}/audio/transcriptions` (`model`, `language`, `response_format=verbose_json`),
 * `http_custom` — на свой адрес с полем `meta` (`{purpose, promptKey, promptVersion, model,
 * input}` без ключа файла). Голос уходит только профилю с известным сроком хранения — это
 * держат сервис профилей и CHECK таблицы (сквозная проверка 18), а не драйвер.
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

// ── Расшифровка: аудио из S3 multipart-запросом (PR-28) ─────────────────────────────────

async function loadAudio(key: string): Promise<Uint8Array> {
  const obj = await s3().send(new GetObjectCommand({ Bucket: S3_BUCKET(), Key: key }))
  return obj.Body!.transformToByteArray()
}

/**
 * Один multipart-запрос с файлом ответа. `fields` — поля формы вендора, `pick` — где в ответе
 * лежит результат (у OpenAI — сам ответ, у `http_custom` — `output`). Нет файла в хранилище —
 * `audio_unavailable`: повтор расшифровки имеет смысл, пока аудио не удалено.
 */
async function runTranscribe(
  req: DriverRequest,
  url: string,
  fields: (audio: { key: string, mime: string, lang: string }) => Record<string, string>,
  pick: (json: unknown) => unknown,
): Promise<DriverResult> {
  const audio = req.prompt.audio?.(req.input)
  if (!audio) return failed('driver_unsupported')
  let bytes: Uint8Array
  try {
    bytes = await loadAudio(audio.key)
  }
  catch {
    return failed('audio_unavailable')
  }
  const form = new FormData()
  const ext = audio.key.split('.').pop() || 'bin'
  form.append('file', new Blob([new Uint8Array(bytes)], { type: audio.mime }), `answer.${ext}`)
  for (const [k, v] of Object.entries(fields(audio))) form.append(k, v)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      // Без Content-Type: границу multipart ставит сам fetch
      headers: { 'Idempotency-Key': req.idempotencyKey, ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}) },
      body: form,
      signal: req.signal,
    })
    if (!res.ok) return failed('http_error', res.status)
    const json = await res.json().catch(() => null)
    const out = pick(json)
    if (out === undefined || out === null) return failed('bad_output', res.status)
    return parsed(req, out, null, null, res.status)
  }
  catch (err) {
    return isTimeout(err) ? { ok: false, status: 'timeout', errorCode: 'timeout', httpStatus: null } : failed('network')
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
  if (purpose === 'transcribe') {
    return runTranscribe(req, `${base}/audio/transcriptions`, audio => ({ model: req.profile.modelName, language: audio.lang, response_format: 'verbose_json' }), json => json)
  }

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
  if (req.profile.purpose === 'transcribe') {
    const { audioKey: _key, ...input } = (req.input ?? {}) as Record<string, unknown>
    return runTranscribe(req, url, () => ({
      meta: JSON.stringify({ purpose: req.profile.purpose, promptKey: req.prompt.key, promptVersion: req.prompt.version, model: req.profile.modelName, input }),
    }), json => (json as { output?: unknown } | null)?.output)
  }
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
