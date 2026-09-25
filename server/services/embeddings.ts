/**
 * Эмбеддинги текста — одна абстракция на провайдера модели (`docs/v2/31` §7.8, §11
 * `library.embedding_refresh`; PR-25). Провайдер — внешний сервис: ключ и договор — вопрос
 * владельца продукта (`HANDOFF` §6, `docs/v2/44` §8), поэтому здесь только интерфейс и две
 * реализации:
 *
 * - `http` — OpenAI-совместимый `POST …/v1/embeddings` с запросом нужной размерности
 *   (`dimensions`); ответ другой длины отвергается, а не обрезается — вектор не той модели хуже,
 *   чем никакого;
 * - `stub` — детерминированная заглушка: хеширование слов и триграмм в `dims` корзин со знаком
 *   и L2-нормировка. Работает без ключа и в тестах; тексты с общими словами получают близкие
 *   векторы, поэтому поиск по телу модуля осмыслен и без провайдера («розведення» в тексте
 *   находится запросом «розведення»).
 *
 * Идентификатор провайдера (`id` = `provider:model:dims`) пишется рядом с вектором
 * (`library_modules.embedding_model`): векторы разных моделей несравнимы, и смена провайдера
 * обязана находить устаревшие строки, а не молча смешивать их в одном поиске.
 *
 * **С PR-27 этот модуль — драйвер, а не точка вызова.** Какой провайдер считает вектор, решает
 * профиль `ai_providers` с ролью `embed`, и каждый вызов идёт через шлюз модели
 * (`server/services/ai/gateway.ts#embedTexts`) — со строкой `ai_calls`, как любой другой вызов
 * модели в продукте. Здесь остались математика заглушки и один HTTP-запрос; выбора провайдера
 * по `EMBEDDINGS_URL` больше нет. Ключ никогда не логируется.
 */

export interface EmbeddingProvider {
  /** `provider:model:dims` — метка модели, которая пишется рядом с вектором. */
  readonly id: string
  readonly dims: number
  /** Вектор на каждый текст в том же порядке; `null` — провайдер не ответил или ответ не той размерности. */
  embed(texts: readonly string[]): Promise<(number[] | null)[]>
}

// ── Заглушка ────────────────────────────────────────────────────────────────────────────

/** FNV-1a, 32 бита: быстрый детерминированный хеш без зависимостей. */
function fnv1a(s: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Слова: буквы и цифры любого алфавита, в нижнем регистре; апостроф — часть украинского слова. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}ʼ'’]+/gu) ?? []
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map(x => x / norm) : v
}

/**
 * Вектор заглушки: каждое слово (вес 1) и его триграммы с границами (вес 0,5) хешируются в
 * корзину со знаком. Триграммы дают близость словоформ («розведення» ~ «розвести»), слово —
 * точное совпадение. Пустой текст — нулевой вектор нормировать нельзя, поэтому `null`.
 */
export function stubVector(text: string, dims: number): number[] | null {
  const words = tokenize(text)
  if (!words.length) return null
  const v = new Array<number>(dims).fill(0)
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature)
    v[h % dims]! += (h & 0x80000000) ? -weight : weight
  }
  for (const w of words) {
    add(`w:${w}`, 1)
    const padded = `^${w}$`
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.5)
  }
  return normalize(v)
}

export function stubEmbeddingProvider(dims: number): EmbeddingProvider {
  return {
    id: `stub:hash-v1:${dims}`,
    dims,
    embed: async texts => texts.map(t => stubVector(t, dims)),
  }
}

// ── OpenAI-совместимый HTTP ──────────────────────────────────────────────────────────────

export interface HttpEmbeddingConfig {
  url: string
  key?: string
  model: string
  dims: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Заголовок `Idempotency-Key` (`docs/v2/30` §7.18) — шлюз передаёт ключ вызова. */
  idempotencyKey?: string
  signal?: AbortSignal
}

export type EmbeddingResponse
  = | { ok: true, vectors: (number[] | null)[], tokensIn: number | null, httpStatus: number }
    | { ok: false, errorCode: 'http_error' | 'bad_output' | 'network' | 'timeout', httpStatus: number | null }

/**
 * Один запрос `POST …/embeddings` с подробным итогом — для шлюза модели (`server/services/ai/`),
 * которому нужно отличить «провайдер не ответил» от «ответил не той размерностью»: первое идёт
 * в журнал как `failed`/`timeout` и уводит на запасной профиль, второе — пустой вектор строки.
 * Ответ другой длины отвергается, а не обрезается — вектор не той модели хуже, чем никакого.
 * Ключ никогда не логируется.
 */
export async function requestEmbeddings(cfg: HttpEmbeddingConfig, texts: readonly string[]): Promise<EmbeddingResponse> {
  const doFetch = cfg.fetchImpl ?? fetch
  const vectors: (number[] | null)[] = texts.map(() => null)
  const idx = texts.map((t, i) => (t.trim() ? i : -1)).filter(i => i >= 0)
  if (!idx.length) return { ok: true, vectors, tokensIn: 0, httpStatus: 0 }
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
        ...(cfg.idempotencyKey ? { 'Idempotency-Key': cfg.idempotencyKey } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: idx.map(i => texts[i]!.slice(0, 8000)), dimensions: cfg.dims }),
      signal: cfg.signal ?? AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    })
    if (!res.ok) return { ok: false, errorCode: 'http_error', httpStatus: res.status }
    const json = await res.json().catch(() => null) as { data?: { index?: number, embedding?: number[] }[], usage?: { prompt_tokens?: number } } | null
    if (!json || !Array.isArray(json.data)) return { ok: false, errorCode: 'bad_output', httpStatus: res.status }
    for (const [n, row] of json.data.entries()) {
      const pos = idx[row.index ?? n]
      if (pos === undefined) continue
      vectors[pos] = Array.isArray(row.embedding) && row.embedding.length === cfg.dims ? row.embedding : null
    }
    return { ok: true, vectors, tokensIn: json.usage?.prompt_tokens ?? null, httpStatus: res.status }
  }
  catch (err) {
    const name = err instanceof Error ? err.name : ''
    return { ok: false, errorCode: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', httpStatus: null }
  }
}

export function httpEmbeddingProvider(cfg: HttpEmbeddingConfig): EmbeddingProvider {
  return {
    id: `http:${cfg.model}:${cfg.dims}`,
    dims: cfg.dims,
    async embed(texts) {
      const r = await requestEmbeddings(cfg, texts)
      if (r.ok) return r.vectors
      console.error(`[embeddings] ${cfg.model}: ${r.errorCode}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''}`)
      return texts.map(() => null)
    },
  }
}

// ── Подмена в тестах ─────────────────────────────────────────────────────────────────────

let override: EmbeddingProvider | null = null

/**
 * Подмена провайдера (тесты). `null` — вернуть выбор по профилю тенанта.
 *
 * С PR-27 провайдера выбирает не окружение, а профиль `ai_providers` с ролью `embed`
 * (`server/services/ai/gateway.ts`): вызов идёт через шлюз и пишется в `ai_calls`. Подмена
 * действует внутри шлюза — журнал и учёт при ней те же, меняется только то, кто считает вектор.
 */
export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  override = p
}

/** Подменённый провайдер нужной размерности или `null` (для шлюза модели). */
export function embeddingOverride(dims: number): EmbeddingProvider | null {
  return override && override.dims === dims ? override : null
}
