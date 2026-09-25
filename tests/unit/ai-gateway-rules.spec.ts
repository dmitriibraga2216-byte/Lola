import { describe, expect, it } from 'vitest'
import { AI_PURPOSES, AI_USAGE_AXES, VACANCY_AI_CRITERIA_MAX, VACANCY_AI_CRITERIA_MIN, VACANCY_AI_TEXT_MAX_CHARS } from '../../shared/enums'
import { AXIS_METER } from '../../server/services/usageCounters'
import {
  AI_PURPOSE_METER, aiUnavailable, buildChain, canonicalJson, digestOf, endpointAllowed, fallbackViolation, idempotencyKey,
  normalizeEndpoint, retentionForbidden, type ChainProfile,
} from '../../server/services/ai/policy'
import { KNOWLEDGE_EMBEDDING_PROMPT, LIBRARY_EMBEDDING_PROMPT, VACANCY_CRITERIA_PROMPT, VACANCY_TEXT_PROMPT, type PromptDef } from '../../server/services/ai/prompts'
import { runDriver, setAiHttp, type DriverProfile } from '../../server/services/ai/drivers'
import { aiProviderCreateSchema, aiProviderUpdateSchema } from '../../shared/schemas/ai'

/**
 * Правила шлюза модели без базы (`docs/v2/30` §3.2, §7.7, §7.12, §7.18; `docs/v2/35` §7.1,
 * §7.7; план `45` PR-27): роль → ось, доступность ИИ по подписке, ключ идемпотентности, срок
 * хранения у расшифровки (сквозная проверка 18), граф запасных, адрес провайдера, промпты и
 * драйверы на подменённом HTTP.
 */

describe('роль профиля → ось тарифа (35 §7.1, 30 §7.12)', () => {
  it('у каждой роли есть строка, и ось — одна из трёх ИИ-осей или «вне тарифа»', () => {
    expect(Object.keys(AI_PURPOSE_METER).sort()).toEqual([...AI_PURPOSES].sort())
    for (const m of Object.values(AI_PURPOSE_METER)) {
      if (m.axis === null) expect(m.charge).toBe('none')
      else expect(AI_USAGE_AXES).toContain(m.axis)
    }
  })

  it('генерация и ИИ-сверка тратят операцию на вызов, собеседование — на сессию, эмбеддинг — ничего', () => {
    expect(AI_PURPOSE_METER.generate).toEqual({ axis: 'ai_generate_ops', charge: 'per_call' })
    expect(AI_PURPOSE_METER.review_hint).toEqual({ axis: 'ai_review_ops', charge: 'per_call' })
    for (const p of ['transcribe', 'interview_score', 'summary'] as const) expect(AI_PURPOSE_METER[p]).toEqual({ axis: 'ai_interview_ops', charge: 'per_session' })
    expect(AI_PURPOSE_METER.embed).toEqual({ axis: null, charge: 'none' })
  })

  it('исчерпание оси: генерация отклоняется, сверка уходит в ручную проверку, новые собеседования не стартуют', () => {
    expect(AXIS_METER.ai_generate_ops).toMatchObject({ kind: 'hard', onExhausted: 'reject' })
    expect(AXIS_METER.ai_review_ops).toMatchObject({ kind: 'hard_degraded', onExhausted: 'manual_review' })
    expect(AXIS_METER.ai_interview_ops).toMatchObject({ kind: 'hard', onExhausted: 'finish_started' })
  })
})

describe('доступность ИИ по подписке (35 §7.7 п. 4, §7.8 п. 4)', () => {
  it('ИИ действует только при активном ИИ и работающем тарифе', () => {
    expect(aiUnavailable({ status: 'active', aiStatus: 'active' })).toBeNull()
    expect(aiUnavailable({ status: 'trial', aiStatus: 'active' })).toBeNull()
    expect(aiUnavailable({ status: 'grace', aiStatus: 'active' })).toBeNull()
    expect(aiUnavailable({ status: 'active', aiStatus: 'expired' })).toBe('expired')
    expect(aiUnavailable({ status: 'active', aiStatus: 'off' })).toBe('off')
    expect(aiUnavailable({ status: 'readonly', aiStatus: 'active' })).toBe('readonly')
    expect(aiUnavailable({ status: 'suspended', aiStatus: 'expired' })).toBe('suspended')
  })
})

describe('дайджест и ключ идемпотентности (30 §3.2, §7.18)', () => {
  it('порядок ключей объекта не меняет дайджест, значение — меняет', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }))
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }))
    expect(digestOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ключ детерминирован и различает промпт, версию и номер попытки', () => {
    const base = { tenantId: 't', refKind: 'interview_session', refId: 'r', promptKey: 'interview.score', promptVersion: 'v1', tryNo: 1 }
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }))
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, tryNo: 2 }))
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, promptVersion: 'v2' }))
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, promptKey: 'summary.build' }))
  })
})

describe('сквозная проверка 18: голос не уходит туда, где неизвестен срок хранения (30 §7.7)', () => {
  it('запрещено только сочетание «расшифровка + unknown»', () => {
    expect(retentionForbidden({ purpose: 'transcribe', providerRetention: 'unknown' })).toBe(true)
    expect(retentionForbidden({ purpose: 'transcribe', providerRetention: 'none' })).toBe(false)
    expect(retentionForbidden({ purpose: 'transcribe', providerRetention: 'ephemeral' })).toBe(false)
    for (const p of AI_PURPOSES.filter(x => x !== 'transcribe')) expect(retentionForbidden({ purpose: p, providerRetention: 'unknown' })).toBe(false)
  })
})

describe('граф запасных профилей (30 §3.2: не сам на себя, глубина ≤ 2)', () => {
  const n = (id: string, purpose: 'transcribe' | 'generate', fallbackProviderId: string | null = null) => ({ id, purpose, fallbackProviderId })

  it('цепочка из двух переходов допустима, из трёх — нет', () => {
    const graph = [n('a', 'generate', 'b'), n('b', 'generate', 'c'), n('c', 'generate')]
    expect(fallbackViolation(graph, n('a', 'generate', 'b'))).toBeNull()
    expect(fallbackViolation([...graph, n('d', 'generate')], n('c', 'generate', 'd'))).toBe('fallback_depth')
  })

  it('сам на себя, чужой (невидимый) профиль, цикл', () => {
    expect(fallbackViolation([n('a', 'generate')], n('a', 'generate', 'a'))).toBe('fallback_self')
    expect(fallbackViolation([n('a', 'generate')], n('a', 'generate', 'other-tenant'))).toBe('fallback_not_found')
    expect(fallbackViolation([n('a', 'generate', 'b'), n('b', 'generate')], n('b', 'generate', 'a'))).toBe('fallback_cycle')
  })

  it('запасной — той же роли: расшифровка не уходит в другую роль, и смена роли не рвёт чужую цепочку', () => {
    expect(fallbackViolation([n('a', 'transcribe'), n('g', 'generate')], n('a', 'transcribe', 'g'))).toBe('fallback_purpose')
    // `b` — запасной для расшифровки `a`; сменить роль `b` значит отправить голос не туда
    expect(fallbackViolation([n('a', 'transcribe', 'b'), n('b', 'transcribe')], n('b', 'generate'))).toBe('fallback_purpose')
  })

  it('цепочка вызова: основной по приоритету, запасные по ссылке, выключенный пропускается', () => {
    const p = (id: string, over: Partial<ChainProfile> = {}): ChainProfile => ({
      id, code: id, purpose: 'generate', driver: 'stub', isActive: true, priority: 100, fallbackProviderId: null, ...over,
    })
    const profiles = [
      p('main', { priority: 10, fallbackProviderId: 'off' }),
      p('off', { isActive: false, fallbackProviderId: 'spare' }),
      p('spare'),
      p('other', { purpose: 'embed', priority: 0 }),
      p('low', { priority: 50 }),
    ]
    expect(buildChain(profiles, 'generate').map(x => x.id)).toEqual(['main', 'spare'])
    expect(buildChain(profiles, 'embed').map(x => x.id)).toEqual(['other'])
    expect(buildChain(profiles, 'summary')).toEqual([])
  })
})

describe('адрес провайдера (SSRF и ключ платформы)', () => {
  it('тенант может вписать только https-адрес в интернете', () => {
    expect(endpointAllowed('https://api.example.com/v1')).toBe(true)
    for (const bad of [
      'http://api.example.com/v1', 'https://localhost:8080/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1',
      'https://192.168.1.10/v1', 'https://172.20.0.1/v1', 'https://169.254.169.254/latest', 'https://minio.internal/v1',
      'https://user:pass@api.example.com/v1', 'https://[::1]/v1', 'not a url',
    ]) expect(endpointAllowed(bad), bad).toBe(false)
  })

  it('хвостовой слеш не делает адрес другим', () => {
    expect(normalizeEndpoint('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeEndpoint('  ')).toBeNull()
  })
})

describe('контракты профиля (shared/schemas/ai.ts)', () => {
  it('ключ — только на запись, лишние поля отвергаются, параметры модели ограничены', () => {
    expect(aiProviderCreateSchema.safeParse({ code: 'spare-gen', name: 'Запасний', purpose: 'generate', driver: 'stub', modelName: 'm' }).success).toBe(true)
    expect(aiProviderCreateSchema.safeParse({ code: 'Bad Code', name: 'X', purpose: 'generate', driver: 'stub', modelName: 'm' }).success).toBe(false)
    expect(aiProviderUpdateSchema.safeParse({ secretRef: 'x' }).success).toBe(false)
    expect(aiProviderUpdateSchema.safeParse({ params: { temperature: 3 } }).success).toBe(false)
    expect(aiProviderUpdateSchema.safeParse({ params: { temperature: 0.2, maxTokens: 800 } }).success).toBe(true)
  })
})

// ── Промпты ─────────────────────────────────────────────────────────────────────────────

describe('промпты вакансии (29 §7.10, §7.11)', () => {
  const input = {
    target: 'requirements' as const, tone: null, title: 'PR27 Офіціант', city: 'Київ', employmentType: null,
    workFormat: null, experienceLevel: null, educationLevel: null, siblingBlocks: {}, language: 'uk' as const,
  }

  it('заглушка детерминирована и укладывается в лимит блока', () => {
    const a = VACANCY_TEXT_PROMPT.stub(input)
    expect(a).toEqual(VACANCY_TEXT_PROMPT.stub({ ...input }))
    expect(a.html.length).toBeLessThanOrEqual(VACANCY_AI_TEXT_MAX_CHARS)
    expect(a.html).toContain('Офіціант')
  })

  it('ответ модели чистится санитайзером и режется по лимиту; пустой — отвергается', () => {
    const parse = VACANCY_TEXT_PROMPT.parse!
    const out = parse({ html: `<p>Привіт</p><script>alert(1)</script>${'<p>ще</p>'.repeat(1000)}` })
    expect(out.html).not.toContain('<script')
    expect(out.html.length).toBeLessThanOrEqual(VACANCY_AI_TEXT_MAX_CHARS)
    expect(() => parse({ html: '<script>x</script>' })).toThrow()
    expect(() => parse({ text: 'нет html' })).toThrow()
  })

  it('критерии: заглушка — от 3 до 8, ответ модели короче трёх — отвергается', () => {
    const r = VACANCY_CRITERIA_PROMPT.stub({ title: 'PR27 Бариста', city: null, employmentType: null, requirementsHtml: null, dutiesHtml: null, language: 'uk' })
    expect(r.criteria.length).toBeGreaterThanOrEqual(VACANCY_AI_CRITERIA_MIN)
    expect(r.criteria.length).toBeLessThanOrEqual(VACANCY_AI_CRITERIA_MAX)
    expect(() => VACANCY_CRITERIA_PROMPT.parse!({ criteria: [{ name: 'Один', weight: 1 }] })).toThrow()
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `К${i}`, description: '', weight: 1 }))
    expect(VACANCY_CRITERIA_PROMPT.parse!({ criteria: nine }).criteria).toHaveLength(VACANCY_AI_CRITERIA_MAX)
  })

  it('в сообщения модели не уходят ни вилка, ни контакты — их нет даже во входе', () => {
    const text = VACANCY_TEXT_PROMPT.chat!(input).map(m => m.content).join('\n')
    expect(text).not.toMatch(/salary":|phone|email/i)
  })
})

describe('промпты эмбеддинга (31 §7.8)', () => {
  it('заглушка даёт вектор заданной длины, пустой текст — null; в журнал — счётчики, не вектор', () => {
    const out = LIBRARY_EMBEDDING_PROMPT.stub({ texts: ['розведення хімії', '  '], dims: 16 })
    expect(out[0]).toHaveLength(16)
    expect(out[1]).toBeNull()
    expect(LIBRARY_EMBEDDING_PROMPT.journal!(out)).toEqual({ count: 2, empty: 1 })
    expect(LIBRARY_EMBEDDING_PROMPT.cacheable).toBe(false)
    expect(KNOWLEDGE_EMBEDDING_PROMPT.purpose).toBe('embed')
  })
})

// ── Драйверы на подменённом HTTP ────────────────────────────────────────────────────────

describe('драйверы (30 §3.2: вендор скрыт за драйвером)', () => {
  const profile = (over: Partial<DriverProfile> = {}): DriverProfile => ({
    id: 'p', driver: 'openai_compatible', purpose: 'generate', endpointUrl: 'https://api.example.test/v1', modelName: 'm', params: { temperature: 0.1 }, ...over,
  })
  const text = VACANCY_TEXT_PROMPT as PromptDef<unknown, unknown>
  const input = { target: 'description', tone: null, title: 'PR27', city: null, employmentType: null, workFormat: null, experienceLevel: null, educationLevel: null, siblingBlocks: {}, language: 'uk' }
  const req = (over: Partial<DriverProfile> = {}, prompt = text, inp: unknown = input) => ({
    profile: profile(over), prompt, input: inp, apiKey: 'sk-test', idempotencyKey: 'k', signal: AbortSignal.timeout(2000),
  })
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('заглушка отвечает без сети', async () => {
    setAiHttp(async () => { throw new Error('сеть недоступна') })
    const r = await runDriver(req({ driver: 'stub', endpointUrl: null }))
    expect(r.ok).toBe(true)
    setAiHttp(null)
  })

  it('OpenAI-совместимый: JSON-ответ через parse(), токены, ключ и Idempotency-Key в заголовках', async () => {
    let seen: { url: string, headers: Record<string, string>, body: Record<string, unknown> } | null = null
    setAiHttp(async (url, init) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"html":"<p>Текст</p>"}' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }), { status: 200 })
    })
    const r = await runDriver(req())
    expect(r).toMatchObject({ ok: true, output: { html: '<p>Текст</p>' }, tokensIn: 12, tokensOut: 5, httpStatus: 200 })
    expect(seen!.url).toBe('https://api.example.test/v1/chat/completions')
    expect(seen!.headers.Authorization).toBe('Bearer sk-test')
    expect(seen!.headers['Idempotency-Key']).toBe('k')
    expect(seen!.body).toMatchObject({ model: 'm', temperature: 0.1, response_format: { type: 'json_object' } })
    setAiHttp(null)
  })

  it('отказ провайдера, невалидный ответ и таймаут — разные коды, а не исключение', async () => {
    setAiHttp(reply(500, { error: 'boom' }))
    expect(await runDriver(req())).toMatchObject({ ok: false, status: 'failed', errorCode: 'http_error', httpStatus: 500 })
    setAiHttp(reply(200, { choices: [{ message: { content: 'не json' } }] }))
    expect(await runDriver(req())).toMatchObject({ ok: false, status: 'failed', errorCode: 'bad_output' })
    setAiHttp(reply(200, { choices: [{ message: { content: '{"html":""}' } }] }))
    expect(await runDriver(req())).toMatchObject({ ok: false, errorCode: 'bad_output' })
    setAiHttp(async (_u, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
    }))
    expect(await runDriver({ ...req(), signal: AbortSignal.timeout(20) })).toMatchObject({ ok: false, status: 'timeout' })
    setAiHttp(null)
  })

  it('эмбеддинги: вектор не той размерности — пустой, не обрезанный', async () => {
    setAiHttp(reply(200, { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [1, 2] }], usage: { prompt_tokens: 4 } }))
    const r = await runDriver(req({ purpose: 'embed' }, LIBRARY_EMBEDDING_PROMPT as PromptDef<unknown, unknown>, { texts: ['a', 'b'], dims: 3 }))
    expect(r).toMatchObject({ ok: true, output: [[1, 2, 3], null], tokensIn: 4 })
    setAiHttp(null)
  })

  // С PR-28 расшифровка по HTTP есть (multipart с аудио из S3, `v2-interview.spec.ts`); промпт без
  // аудио во входе по-прежнему честно отказывает `driver_unsupported`, а не шлёт JSON вместо файла
  it('свой HTTP-контракт и честный отказ расшифровки промптом без аудио', async () => {
    setAiHttp(reply(200, { output: { html: '<p>Свій</p>' }, usage: { tokensIn: 3, tokensOut: 2 } }))
    expect(await runDriver(req({ driver: 'http_custom', endpointUrl: 'https://proxy.example.test/generate' }))).toMatchObject({ ok: true, output: { html: '<p>Свій</p>' } })
    expect(await runDriver(req({ purpose: 'transcribe' }))).toMatchObject({ ok: false, errorCode: 'driver_unsupported' })
    expect(await runDriver(req({ endpointUrl: null }))).toMatchObject({ ok: false, errorCode: 'provider_not_configured' })
    setAiHttp(null)
  })
})
