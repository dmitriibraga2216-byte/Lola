import { describe, expect, it } from 'vitest'
import {
  LIBRARY_LIMITS, authorIdsOf, bodyStats, canEditModule, canTransition, deletionVerdict, diffBlocks, embeddingText,
  hotfixDecision, isEmptyDiff, isHybridQuery, isStale, mediaIdsOf, prefixTsQuery, restoredStatus, rrfMerge, searchWords,
  skippedVersions, typeIconOf, updateVerdict,
} from '../../shared/domain/library'
import {
  libraryAttachSchema, libraryDetachSchema, libraryListQuerySchema, libraryModuleCreateSchema, libraryPublishVersionSchema,
  libraryUpdatePreviewQuerySchema, libraryUpdateVersionSchema,
} from '../../shared/schemas/library'
import { httpEmbeddingProvider, stubEmbeddingProvider, stubVector, tokenize } from '../../server/services/embeddings'

/**
 * Правила библиотеки модулей (`docs/v2/31-module-library.md` §4, §7; PR-25 плана `docs/v2/45`).
 * Здесь — ровно те решения, ошибка в которых не видна глазом и дорого стоит:
 *
 * - **удаление** (§7.5, Р-31.3): используемый модуль не удаляется — ни при активных местах,
 *   ни при отключённых, ни при истории версий (критерий приёмки 3 держится на этом правиле);
 * - **чужой модуль** (§7.12): автор без `library.manage` правит только то, где он в `author_ids`;
 * - **переходы** (§4): из архива в черновик дороги нет;
 * - **diff** по `block.id`, а не по позиции;
 * - **эмбеддинг-заглушка** работает без ключа (`HANDOFF` §6) и осмысленна: общие слова дают
 *   близкие векторы, чужие — далёкие.
 */

describe('§7.5 удаление: только модуль, который ничего не держит', () => {
  it('модуль без мест и с одной версией удаляется', () => {
    expect(deletionVerdict({ active: 0, detached: 0, versions: 1 })).toEqual({ allowed: true })
    expect(deletionVerdict({ active: 0, detached: 0, versions: 0 })).toEqual({ allowed: true })
  })

  it('три активных места — нельзя (критерий 3): причина — активные места', () => {
    expect(deletionVerdict({ active: 3, detached: 0, versions: 1 })).toEqual({ allowed: false, reason: 'active_usages' })
  })

  it('отключённые места тоже держат модуль: строка места нужна отчёту и не удаляется', () => {
    expect(deletionVerdict({ active: 0, detached: 1, versions: 1 })).toEqual({ allowed: false, reason: 'detached_usages' })
  })

  it('больше одной версии — модуль уже жил, его история кому-то нужна', () => {
    expect(deletionVerdict({ active: 0, detached: 0, versions: 2 })).toEqual({ allowed: false, reason: 'versions' })
  })

  it('активные места важнее прочих причин — сообщение называет число мест', () => {
    expect(deletionVerdict({ active: 1, detached: 5, versions: 9 })).toEqual({ allowed: false, reason: 'active_usages' })
  })
})

describe('§7.12 правка чужого модуля', () => {
  const module = { authorIds: ['owner', 'co'] }
  it('носитель library.manage правит любой модуль', () => {
    expect(canEditModule({ actorId: 'stranger', manage: true, publish: false }, module)).toBe(true)
  })
  it('автор с library.publish правит, если он в author_ids', () => {
    expect(canEditModule({ actorId: 'co', manage: false, publish: true }, module)).toBe(true)
  })
  it('автор с library.publish, но не в author_ids — нет («Зверніться до власника модуля»)', () => {
    expect(canEditModule({ actorId: 'stranger', manage: false, publish: true }, module)).toBe(false)
  })
  it('соавтор без library.publish — нет: право положить и право править идут вместе', () => {
    expect(canEditModule({ actorId: 'co', manage: false, publish: false }, module)).toBe(false)
  })
  it('author_ids: владелец первым, без дубля и без повтора соавторов', () => {
    expect(authorIdsOf('o', ['a', 'o', 'a', 'b'])).toEqual(['o', 'a', 'b'])
    expect(authorIdsOf('o')).toEqual(['o'])
  })
})

describe('§4 переходы статуса модуля', () => {
  it('draft → published и draft → archived допустимы', () => {
    expect(canTransition('draft', 'published')).toBe(true)
    expect(canTransition('draft', 'archived')).toBe(true)
  })
  it('published → archived → published — архивирование и восстановление', () => {
    expect(canTransition('published', 'archived')).toBe(true)
    expect(canTransition('archived', 'published')).toBe(true)
  })
  it('archived → draft запрещено: у модуля уже есть версии и места', () => {
    expect(canTransition('archived', 'draft')).toBe(false)
    expect(canTransition('published', 'draft')).toBe(false)
  })
  it('восстановление: с версией — published, заархивированный черновик — обратно в draft', () => {
    expect(restoredStatus(true)).toBe('published')
    expect(restoredStatus(false)).toBe('draft')
  })
})

describe('§7.9 устаревание места', () => {
  it('место на другой версии — устарело', () => expect(isStale('v2', 'v3')).toBe(true))
  it('место на текущей версии — нет', () => expect(isStale('v3', 'v3')).toBe(false))
  it('у модуля ещё нет текущей версии — обновляться не на что', () => expect(isStale('v2', null)).toBe(false))
})

describe('§3.3 поблочный diff по block.id', () => {
  const b = (id: string, text: string) => ({ id, type: 'text', html: text })

  it('добавленные, удалённые и изменённые блоки — по идентификатору', () => {
    const before = [b('a', 'A'), b('b', 'B'), b('c', 'C')]
    const after = [b('a', 'A'), b('c', 'C2'), b('d', 'D')]
    expect(diffBlocks(before, after)).toEqual({ added: ['d'], removed: ['b'], changed: ['c'] })
  })

  it('перестановка блоков — не правка: diff пуст', () => {
    const before = [b('a', 'A'), b('b', 'B')]
    expect(isEmptyDiff(diffBlocks(before, [...before].reverse()))).toBe(true)
  })

  it('вставка абзаца в начало не делает «изменёнными» блоки ниже', () => {
    const before = [b('a', 'A'), b('b', 'B')]
    expect(diffBlocks(before, [b('z', 'Z'), ...before])).toEqual({ added: ['z'], removed: [], changed: [] })
  })

  it('первая версия — всё добавлено', () => {
    expect(diffBlocks([], [b('a', 'A')])).toEqual({ added: ['a'], removed: [], changed: [] })
  })
})

describe('§7.13 медиа версии и §7.8 текст эмбеддинга', () => {
  it('медиа: основной файл и медиа блоков, без повторов и без блоков без файла', () => {
    const body = [{ id: '1', type: 'image', mediaId: 'm1' }, { id: '2', type: 'text', html: 'x' }, { id: '3', type: 'video', mediaId: 'm1' }, { id: '4', type: 'file', mediaId: 'm2' }]
    expect(mediaIdsOf('main', body).sort()).toEqual(['m1', 'm2', 'main'])
    expect(mediaIdsOf(null, [])).toEqual([])
  })

  it('в эмбеддинг идут название, описание, метки и тело последней версии', () => {
    const text = embeddingText({ title: 'Використання хімії', summary: 'Коротко', tags: ['прибирання'], plainText: 'Правила розведення засобів' })
    expect(text).toContain('Використання хімії')
    expect(text).toContain('прибирання')
    expect(text).toContain('розведення')
  })

  it('текст эмбеддинга ограничен 8000 знаками', () => {
    expect(embeddingText({ title: 'T', plainText: 'x'.repeat(20_000) }).length).toBeLessThanOrEqual(8000)
  })
})

describe('embeddings: заглушка работает без ключа и осмысленна', () => {
  const dims = LIBRARY_LIMITS.embeddingDims
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)

  it('детерминирована и нормирована, размерность — 768', () => {
    const v1 = stubVector('Правила розведення хімії', dims)!
    const v2 = stubVector('Правила розведення хімії', dims)!
    expect(v1).toHaveLength(dims)
    expect(v1).toEqual(v2)
    expect(Math.abs(cos(v1, v1) - 1)).toBeLessThan(1e-9)
  })

  it('«розведення» ближе к тексту со словом «розведення», чем к постороннему тексту', () => {
    const q = stubVector('розведення', dims)!
    const hit = stubVector('Використання хімії: розведення засобів у пропорції 1:10', dims)!
    const miss = stubVector('Графік змін на кухні та правила подачі страв', dims)!
    expect(cos(q, hit)).toBeGreaterThan(cos(q, miss))
    expect(cos(q, hit)).toBeGreaterThan(0.1)
  })

  it('пустой текст вектора не даёт', () => {
    expect(stubVector('   ', dims)).toBeNull()
  })

  it('слова — буквы и цифры любого алфавита, апостроф внутри слова сохраняется', () => {
    expect(tokenize('Обʼєм 10 л, «pH»!')).toEqual(['обʼєм', '10', 'л', 'ph'])
  })

  it('провайдер-заглушка метит векторы своей моделью', async () => {
    const p = stubEmbeddingProvider(dims)
    expect(p.id).toBe('stub:hash-v1:768')
    const [a, b] = await p.embed(['текст', ''])
    expect(a).toHaveLength(dims)
    expect(b).toBeNull()
  })
})

describe('embeddings: HTTP-провайдер (OpenAI-совместимый) без сети', () => {
  const ok = (vectors: number[][]) => (async () => new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }), { status: 200 })) as unknown as typeof fetch

  it('просит нужную размерность и раскладывает ответ по входам, пустые тексты не отправляет', async () => {
    let sent: { dimensions?: number, input?: string[] } = {}
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body)
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [0, 1, 0] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const p = httpEmbeddingProvider({ url: 'https://example.invalid/v1/embeddings', model: 'm', dims: 3, fetchImpl })
    const out = await p.embed(['a', '', 'b'])
    expect(sent.dimensions).toBe(3)
    expect(sent.input).toEqual(['a', 'b'])
    expect(out).toEqual([[1, 0, 0], null, [0, 1, 0]])
    expect(p.id).toBe('http:m:3')
  })

  it('ответ не той размерности отвергается, а не обрезается', async () => {
    const p = httpEmbeddingProvider({ url: 'https://example.invalid', model: 'm', dims: 3, fetchImpl: ok([[1, 2]]) })
    expect(await p.embed(['a'])).toEqual([null])
  })

  it('отказ провайдера не роняет публикацию — вектора просто нет', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const p = httpEmbeddingProvider({ url: 'https://example.invalid', model: 'm', dims: 3, fetchImpl: failing })
    expect(await p.embed(['a'])).toEqual([null])
  })
})

describe('контракты §6, §10', () => {
  it('создание: по умолчанию article, uk, пустые метки и тело; тип — из перечня resources.kind', () => {
    const p = libraryModuleCreateSchema.parse({ title: 'Використання хімії' })
    expect(p).toMatchObject({ contentKind: 'article', language: 'uk', tags: [], body: [], coauthorIds: [] })
    expect(libraryModuleCreateSchema.safeParse({ title: 'Модуль', contentKind: 'quiz' }).success).toBe(false)
  })

  it('«Назва від 3 символів» и «Власник уже у списку» — тексты формы §6.1', () => {
    const short = libraryModuleCreateSchema.safeParse({ title: 'Аб' })
    expect(short.success).toBe(false)
    expect(short.error!.issues[0]!.message).toBe('Назва від 3 символів')
    const dup = libraryModuleCreateSchema.safeParse({ title: 'Модуль', ownerId: '00000000-0000-4000-8000-000000000001', coauthorIds: ['00000000-0000-4000-8000-000000000001'] })
    expect(dup.success).toBe(false)
    expect(dup.error!.issues[0]!.message).toBe('Власник уже у списку')
  })

  it('«Що змінилось» обязательно, 5–500 (§6.2)', () => {
    expect(libraryPublishVersionSchema.safeParse({ changelog: 'ok' }).success).toBe(false)
    expect(libraryPublishVersionSchema.parse({ changelog: 'Додано розділ' })).toMatchObject({ isHotfix: false, notify: true })
  })

  it('вставка: узел — только в траекторию, урок — только в курс; режим по умолчанию hotfix_auto', () => {
    const base = { libraryModuleId: '00000000-0000-4000-8000-000000000001', holderId: '00000000-0000-4000-8000-000000000002', containerId: '00000000-0000-4000-8000-000000000003' }
    expect(libraryAttachSchema.safeParse({ ...base, holderType: 'trajectory_node', containerType: 'course' }).success).toBe(false)
    expect(libraryAttachSchema.parse({ ...base, holderType: 'course_lesson', containerType: 'course' }).pinMode).toBe('hotfix_auto')
  })

  it('список: по умолчанию архив скрыт, страница 25; флаги из query — не «любая строка = true»', () => {
    expect(libraryListQuerySchema.parse({})).toMatchObject({ status: 'active', limit: 25 })
    expect(libraryListQuerySchema.parse({ onlyUnused: 'false' }).onlyUnused).toBe(false)
    expect(libraryListQuerySchema.parse({ onlyUnused: 'true' }).onlyUnused).toBe(true)
    expect(libraryListQuerySchema.safeParse({ limit: '30' }).success).toBe(false)
  })

  it('битый или самодельный курсор отсекается на входе, а не превращается в первую страницу', () => {
    expect(libraryListQuerySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false)
    expect(libraryListQuerySchema.safeParse({ cursor: Buffer.from('["2026-09-24T10:00:00.123Z","x"]').toString('base64url') }).success).toBe(false)
    expect(libraryListQuerySchema.safeParse({ cursor: '' }).success).toBe(true)
  })
})

// ── PR-26: иконка «Тип», поиск, обновление места, хотфикс ──────────────────────────────

describe('§7.7 иконка колонки «Тип» (критерий 7)', () => {
  const block = (type: string, html?: string) => ({ type, ...(html === undefined ? {} : { html }) })

  it('article с 6 чек-листами из 10 — чек-лист; ровно половина — тоже чек-лист', () => {
    const body = [...Array.from({ length: 6 }, () => block('checklist')), ...Array.from({ length: 4 }, () => block('text', '<p>x</p>'))]
    expect(typeIconOf('article', bodyStats(body))).toBe('checklist')
    expect(typeIconOf('article', bodyStats([block('checklist'), block('text', '<p>x</p>')]))).toBe('checklist')
  })

  it('меньше половины чек-листов: таблица (блок table или <table> в тексте), иначе «T»', () => {
    expect(typeIconOf('article', bodyStats([block('checklist'), block('text', '<TABLE><tr><td>1</td></tr></TABLE>'), block('text', '<p>x</p>')]))).toBe('table')
    expect(typeIconOf('article', bodyStats([block('table'), block('text', '<p>x</p>')]))).toBe('table')
    expect(typeIconOf('article', bodyStats([block('checklist'), block('text', '<p>tablet</p>'), block('heading')]))).toBe('text')
  })

  it('file — документ, video — плёнка, link — цепочка; пустое тело и тело неизвестно — «T»', () => {
    expect(typeIconOf('file', null)).toBe('file')
    expect(typeIconOf('video', bodyStats([block('checklist')]))).toBe('video')
    expect(typeIconOf('link', null)).toBe('link')
    expect(typeIconOf('article', bodyStats([]))).toBe('text')
    expect(typeIconOf('article', null)).toBe('text')
  })
})

describe('§7.8 поиск: слова, префиксы, гибрид, RRF (критерий 8)', () => {
  it('слова: буквы и цифры, от двух знаков, без повторов, не больше восьми', () => {
    expect(searchWords('  Розведення, розведення 1:10 — а ще!')).toEqual(['розведення', '10', 'ще'])
    expect(searchWords('a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh ii')).toHaveLength(LIBRARY_LIMITS.searchWordsMax)
  })

  it('префиксный запрос не пропускает операторы to_tsquery из ввода', () => {
    expect(prefixTsQuery('розвед хім')).toBe('розвед:* & хім:*')
    expect(prefixTsQuery("x' | !y & (z) <-> :*")).toBeNull()
    expect(prefixTsQuery("хлор' | !кислота")).toBe('хлор:* & кислота:*')
    expect(prefixTsQuery('   ')).toBeNull()
  })

  it('гибрид — с четырёх слов («длиннее трёх»)', () => {
    expect(isHybridQuery('розведення')).toBe(false)
    expect(isHybridQuery('як розводити засоби')).toBe(false)
    expect(isHybridQuery('як правильно розводити засоби')).toBe(true)
  })

  it('RRF: найденное обоими способами выше найденного одним; при равенстве — порядок полнотекста; лимит', () => {
    // c: 1/63 + 1/61 — выше всех; b и d — по 1/62, при равенстве раньше полнотекстовый b
    expect(rrfMerge([['a', 'b', 'c'], ['c', 'd']])).toEqual(['c', 'a', 'b', 'd'])
    expect(rrfMerge([['a', 'b'], ['b', 'a']])).toEqual(['a', 'b'])
    expect(rrfMerge([['a', 'b', 'c'], []], 2)).toEqual(['a', 'b'])
    expect(rrfMerge([[], []])).toEqual([])
  })

  it('порог вектора отсекает посторонний длинный запрос и пропускает свой (заглушка без ключа)', () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)
    const body = stubVector('Використання хімії\nПравила розведення засобів для підлоги: 1:10 у теплій воді', 768)!
    expect(cos(stubVector('як правильно розводити засоби для миття підлоги', 768)!, body)).toBeGreaterThanOrEqual(LIBRARY_LIMITS.vectorMinSimilarity)
    expect(cos(stubVector('зовсім інша тема про погоду завтра вранці', 768)!, body)).toBeLessThan(LIBRARY_LIMITS.vectorMinSimilarity)
  })
})

describe('§7.3 обновление места: только вперёд (критерий 2)', () => {
  it('новее и опубликована — можно; та же — already_latest; старее — отката нет; retired — нельзя', () => {
    expect(updateVerdict(2, { version: 4, status: 'published' })).toEqual({ ok: true })
    expect(updateVerdict(4, { version: 4, status: 'published' })).toEqual({ ok: false, code: 'already_latest' })
    expect(updateVerdict(4, { version: 2, status: 'published' })).toEqual({ ok: false, code: 'version_downgrade' })
    expect(updateVerdict(2, { version: 3, status: 'retired' })).toEqual({ ok: false, code: 'version_retired' })
  })

  it('changelog пропущенных версий — строго после закреплённой и до целевой, по возрастанию', () => {
    const versions = [4, 1, 3, 2, 5].map(version => ({ version }))
    expect(skippedVersions(versions, 2, 4).map(v => v.version)).toEqual([3, 4])
    expect(skippedVersions(versions, 4, 4)).toEqual([])
  })

  it('контракты: toVersion необязателен и только положительный; makeCopy по умолчанию включён', () => {
    expect(libraryUpdateVersionSchema.parse({})).toEqual({})
    expect(libraryUpdateVersionSchema.safeParse({ toVersion: 0 }).success).toBe(false)
    expect(libraryUpdatePreviewQuerySchema.parse({ toVersion: '4' })).toEqual({ toVersion: 4 })
    expect(libraryDetachSchema.parse({})).toEqual({ makeCopy: true })
  })
})

describe('§7.4 «Критичне виправлення» (критерий 6)', () => {
  const base = { pinMode: 'hotfix_auto', pinnedVersion: 2, hotfixVersion: 3, inProgress: 0, holderMutable: true }

  it('hotfix_auto и ни одного прохождения в процессе — применить', () => {
    expect(hotfixDecision(base)).toBe('apply')
  })

  it('пять человек в процессе — место остаётся устаревшим, автору — library_hotfix_blocked', () => {
    expect(hotfixDecision({ ...base, inProgress: 5 })).toBe('blocked_in_progress')
  })

  it('fixed хотфикс сам не получает; место уже на хотфиксе или новее — делать нечего', () => {
    expect(hotfixDecision({ ...base, pinMode: 'fixed' })).toBe('skip_fixed')
    expect(hotfixDecision({ ...base, pinnedVersion: 3 })).toBe('skip_newer')
    expect(hotfixDecision({ ...base, pinnedVersion: 4, pinMode: 'fixed', inProgress: 9 })).toBe('skip_newer')
  })

  it('урок опубликованной версии курса не правится даже без людей в процессе', () => {
    expect(hotfixDecision({ ...base, holderMutable: false })).toBe('blocked_published')
    expect(hotfixDecision({ ...base, holderMutable: false, inProgress: 2 })).toBe('blocked_in_progress')
  })
})
