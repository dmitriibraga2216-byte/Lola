/**
 * Эмбеддинги текста — одна абстракция на провайдера модели (`docs/v2/31` §7.8, §11
 * `library.embedding_refresh`; PR-25). Провайдер — внешний сервис: ключ и договор — вопрос
 * владельца продукта (`HANDOFF` §6, `docs/v2/44` §8), поэтому здесь только интерфейс и две
 * реализации:
 *
 * - `http` — OpenAI-совместимый `POST …/v1/embeddings` (`EMBEDDINGS_URL`, `EMBEDDINGS_API_KEY`,
 *   `EMBEDDINGS_MODEL`) с запросом нужной размерности (`dimensions`); ответ другой длины
 *   отвергается, а не обрезается — вектор не той модели хуже, чем никакого;
 * - `stub` — детерминированная заглушка: хеширование слов и триграмм в `dims` корзин со знаком
 *   и L2-нормировка. Работает без ключа и в тестах; тексты с общими словами получают близкие
 *   векторы, поэтому поиск по телу модуля осмыслен и без провайдера («розведення» в тексте
 *   находится запросом «розведення»).
 *
 * Идентификатор провайдера (`id` = `provider:model:dims`) пишется рядом с вектором
 * (`library_modules.embedding_model`): векторы разных моделей несравнимы, и смена провайдера
 * обязана находить устаревшие строки, а не молча смешивать их в одном поиске.
 *
 * Ключ никогда не логируется. `knowledge.ts#embed()` (база знаний, 1536 измерений) пока живёт
 * своим вызовом того же `EMBEDDINGS_URL` — перевод на эту абстракцию вместе с поиском (PR-26).
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
}

export function httpEmbeddingProvider(cfg: HttpEmbeddingConfig): EmbeddingProvider {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    id: `http:${cfg.model}:${cfg.dims}`,
    dims: cfg.dims,
    async embed(texts) {
      const out: (number[] | null)[] = texts.map(() => null)
      const idx = texts.map((t, i) => (t.trim() ? i : -1)).filter(i => i >= 0)
      if (!idx.length) return out
      try {
        const res = await doFetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
          body: JSON.stringify({ model: cfg.model, input: idx.map(i => texts[i]!.slice(0, 8000)), dimensions: cfg.dims }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
        })
        if (!res.ok) {
          console.error(`[embeddings] ${cfg.model}: HTTP ${res.status}`)
          return out
        }
        const json = await res.json() as { data?: { index?: number, embedding?: number[] }[] }
        for (const [n, row] of (json.data ?? []).entries()) {
          const pos = idx[row.index ?? n]
          if (pos === undefined) continue
          out[pos] = Array.isArray(row.embedding) && row.embedding.length === cfg.dims ? row.embedding : null
        }
        return out
      }
      catch (err) {
        console.error(`[embeddings] ${cfg.model}:`, err instanceof Error ? err.message : err)
        return out
      }
    },
  }
}

// ── Выбор провайдера ─────────────────────────────────────────────────────────────────────

let override: EmbeddingProvider | null = null

/** Подмена провайдера (тесты). `null` — вернуть выбор по окружению. */
export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  override = p
}

/**
 * Провайдер для нужной размерности: HTTP, если задан `EMBEDDINGS_URL`, иначе заглушка.
 * Без ключа система не падает и не молчит — поиск работает на заглушке, а после подключения
 * провайдера `library.embedding_refresh` пересчитывает строки с чужой меткой модели.
 */
export function embeddingProvider(dims: number): EmbeddingProvider {
  if (override && override.dims === dims) return override
  const url = process.env.EMBEDDINGS_URL
  if (url) {
    return httpEmbeddingProvider({
      url,
      key: process.env.EMBEDDINGS_API_KEY || undefined,
      model: process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
      dims,
    })
  }
  return stubEmbeddingProvider(dims)
}
