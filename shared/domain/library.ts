/**
 * Правила библиотеки переиспользуемых модулей (`docs/v2/31-module-library.md` §4, §7;
 * PR-25 плана `docs/v2/45`). Чистые функции без БД — их проверяет `tests/unit/library-rules.spec.ts`,
 * сервисы (`server/services/library*.ts`) только применяют их внутри `withTenant()`.
 *
 * Здесь живут ровно те решения, ошибка в которых не видна глазом:
 * - когда модуль можно удалить физически, а когда только заархивировать (§7.5, Р-31.3);
 * - кто вправе править чужой модуль (§7.12);
 * - какие переходы статуса допустимы (§4);
 * - поблочный diff версий (§3.3 `diff`) — по `block.id`, а не по позиции блока.
 */
import type { LibraryHolderType, LibraryContainerType, LibraryModuleStatus } from '../enums'

/** Числа из `31` §3, §6, §7 — одни и те же для сервера, формы и тестов. */
export const LIBRARY_LIMITS = {
  titleMin: 3,
  titleMax: 200,
  summaryMax: 300,
  tagsMax: 20,
  /** `author_ids` 1–10 (§3.2): владелец плюс не больше девяти соавторов. */
  authorsMax: 10,
  minutesMin: 1,
  minutesMax: 600,
  reasonMin: 5,
  reasonMax: 500,
  changelogMin: 5,
  changelogMax: 500,
  proposalCommentMax: 500,
  decisionCommentMin: 5,
  decisionCommentMax: 500,
  /** «до 50 записей плюс общее число» в `409 library_module.in_use` (§7.5). */
  usagesInConflict: 50,
  /** Размерность эмбеддинга тела (§3.6 `vector(768)`, §7.8). */
  embeddingDims: 768,
  /** Батч задачи `library.embedding_refresh` (§11). */
  embeddingBatch: 20,
  /** Страница списка (§5.1: 25/50/100). */
  pageSizes: [25, 50, 100] as const,
  /** Поиск (§7.8): «результаты сливаются по RRF, лимит 50». */
  searchLimit: 50,
  /** Константа RRF: 1 / (k + ранг). 60 — общепринятое значение, при котором первые места списков не заглушают остальные. */
  rrfK: 60,
  /** «Запрос длиннее трёх слов уходит в гибрид» (§7.8): с четырёх слов к полнотексту добавляется вектор. */
  hybridMinWords: 4,
  /**
   * Нижняя граница косинусной близости векторной части. Без неё вектор «находит» любой модуль,
   * и «Нічого не знайшли» (§5.1) не показалось бы никогда. `[решение]` PR-26 — см. `31` §7.8.
   */
  vectorMinSimilarity: 0.2,
  /** Сколько слов запроса учитывается (как у поиска базы знаний, `knowledge.ts#search`). */
  searchWordsMax: 8,
  /** Палитра вставки (§5.4): «до 8 последних использованных модулей». */
  paletteRecent: 8,
} as const

// ── Права (§2, §7.12) ───────────────────────────────────────────────────────────────────

export interface LibraryActorRights {
  actorId: string
  /** `library.manage` — чужие модули, физическое удаление, массовое обновление. */
  manage: boolean
  /** `library.publish` — класть в библиотеку и публиковать версии своих модулей. */
  publish: boolean
}

/**
 * Править модуль (карточку, черновик, версии, архив) вправе носитель `library.manage` или
 * носитель `library.publish`, который есть в `author_ids` (§7.12). Владелец в `author_ids`
 * всегда — сервис кладёт его туда сам, поэтому отдельной проверки владельца нет.
 */
export function canEditModule(actor: LibraryActorRights, module: { authorIds: readonly string[] }): boolean {
  if (actor.manage) return true
  return actor.publish && module.authorIds.includes(actor.actorId)
}

/** Состав `author_ids`: владелец первым, соавторы без повторов и без владельца (§6.1 «Власник уже у списку»). */
export function authorIdsOf(ownerId: string, coauthorIds: readonly string[] = []): string[] {
  return [ownerId, ...[...new Set(coauthorIds)].filter(id => id !== ownerId)]
}

// ── Состояния (§4) ──────────────────────────────────────────────────────────────────────

/**
 * Допустимые переходы карточки (§4): `draft → published` делает первая версия,
 * `draft|published → archived` — архивирование, `archived → published` — восстановление.
 * Из `archived` в `draft` дороги нет: у модуля уже есть версии и места использования.
 */
const MODULE_TRANSITIONS: Record<LibraryModuleStatus, readonly LibraryModuleStatus[]> = {
  draft: ['published', 'archived'],
  published: ['archived'],
  archived: ['published'],
}

export function canTransition(from: LibraryModuleStatus, to: LibraryModuleStatus): boolean {
  return MODULE_TRANSITIONS[from].includes(to)
}

/**
 * Куда возвращается модуль из архива. §4 знает только `archived → published`, потому что
 * рассуждает о модуле с версиями. Модуль, заархивированный из черновика (`draft → archived`
 * §4 разрешает), версий не имеет, и «опубликованным» без версии он быть не может —
 * `[решение]` он возвращается в `draft`: запрет §4 («у модуля уже есть версии») к нему не относится.
 */
export function restoredStatus(hasPublishedVersion: boolean): LibraryModuleStatus {
  return hasPublishedVersion ? 'published' : 'draft'
}

// ── Удаление (§7.5, Р-31.3) ─────────────────────────────────────────────────────────────

export type DeletionVerdict
  = | { allowed: true }
    | { allowed: false, reason: 'active_usages' | 'detached_usages' | 'versions' }

/**
 * Физическое удаление — только когда модуль ничего не держит: активных мест 0, отключённых
 * мест 0 и версий не больше одной. Отключённые места считаются, потому что строка
 * `library_module_usages` нужна отчёту и проверке §7.5 и не удаляется (§4); больше одной
 * версии — значит, модуль уже жил и его история кому-то нужна. Во всех прочих случаях —
 * архивирование (`409 library_module.in_use` с предложением «Заархівувати»).
 */
export function deletionVerdict(counts: { active: number, detached: number, versions: number }): DeletionVerdict {
  if (counts.active > 0) return { allowed: false, reason: 'active_usages' }
  if (counts.detached > 0) return { allowed: false, reason: 'detached_usages' }
  if (counts.versions > 1) return { allowed: false, reason: 'versions' }
  return { allowed: true }
}

// ── Места использования (§3.4, §7.2, §7.9) ──────────────────────────────────────────────

/** Контейнер, которому принадлежит держатель ссылки (§3.4): узел — траектории, урок — курсу. */
export const CONTAINER_OF_HOLDER: Record<LibraryHolderType, LibraryContainerType> = {
  trajectory_node: 'trajectory',
  course_lesson: 'course',
}

/**
 * Устарело ли место (§7.9): закреплена не последняя опубликованная версия. Место без
 * текущей версии модуля (модуль ещё не публиковался) устаревшим не бывает — ему не на что
 * обновляться.
 */
export function isStale(pinnedVersionId: string, currentVersionId: string | null): boolean {
  return !!currentVersionId && pinnedVersionId !== currentVersionId
}

// ── Поблочный diff (§3.3 `diff`, §5.5) ──────────────────────────────────────────────────

export interface BlockDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/**
 * Разница двух тел по `block.id` (§3.3): добавленные, удалённые и изменённые блоки.
 * Сравнение по идентификатору, а не по позиции: перестановка блоков — не правка текста,
 * а вставка абзаца в начало не должна помечать «изменёнными» все блоки ниже. Порядок в
 * каждом списке — порядок блоков в том теле, где они есть (новое для added/changed,
 * старое для removed), чтобы диалог обновления показывал их в порядке чтения.
 */
export function diffBlocks(before: readonly { id: string }[], after: readonly { id: string }[]): BlockDiff {
  const prev = new Map(before.map(b => [b.id, JSON.stringify(b)]))
  const next = new Set(after.map(b => b.id))
  return {
    added: after.filter(b => !prev.has(b.id)).map(b => b.id),
    removed: before.filter(b => !next.has(b.id)).map(b => b.id),
    changed: after.filter(b => prev.has(b.id) && prev.get(b.id) !== JSON.stringify(b)).map(b => b.id),
  }
}

/** Пустой ли diff — версия без единой правки тела (например, поменяли только название). */
export function isEmptyDiff(d: BlockDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length
}

// ── Медиа версии (§3.3 `media_ids`, §7.13) ──────────────────────────────────────────────

/**
 * Файлы, которые держит версия: основной файл материала (`file`/`video`) и медиа блоков тела.
 * Список пишется в `library_module_versions.media_ids` и не даёт удалить медиа, пока его
 * держит хоть одна опубликованная версия, а не только последняя (§7.13).
 */
export function mediaIdsOf(mediaId: string | null | undefined, body: readonly unknown[]): string[] {
  const ids = new Set<string>()
  if (mediaId) ids.add(mediaId)
  for (const b of body) {
    const m = (b as { mediaId?: unknown }).mediaId
    if (typeof m === 'string' && m) ids.add(m)
  }
  return [...ids]
}

// ── Текст для эмбеддинга (§7.8) ─────────────────────────────────────────────────────────

/**
 * Что уходит в эмбеддинг: название, описание, метки и тело **последней опубликованной
 * версии** (§7.8 — «Використання хімії» ищут словом «розведення», которого нет в названии).
 * Черновик не индексируется: поиск находит то, что можно вставить, а вставляется версия.
 */
export function embeddingText(v: { title: string, summary?: string | null, tags?: readonly string[], plainText?: string | null }): string {
  return [v.title, v.summary ?? '', (v.tags ?? []).join(' '), v.plainText ?? '']
    .map(s => s.trim()).filter(Boolean).join('\n').slice(0, 8000)
}

// ── Иконка колонки «Тип» (§7.7, Р-31.5, критерий 7) ──────────────────────────────────────

/**
 * Что показывает колонка «Тип» и палитра вставки. Это вывод для экрана, а не перечень БД:
 * `content_kind` остаётся перечнем `resources.kind` и в API не меняется (критерий 7).
 */
export const LIBRARY_TYPE_ICONS = ['text', 'checklist', 'table', 'file', 'video', 'link'] as const
export type LibraryTypeIcon = typeof LIBRARY_TYPE_ICONS[number]

/** Состав тела, по которому выбирается иконка `article` (§7.7) — сервер считает его запросом, тесты — `bodyStats`. */
export interface BodyStats {
  blocks: number
  checklists: number
  hasTable: boolean
}

/**
 * Таблица в теле. `11` §3.3 называет блок `table`, но в репозитории его нет (`blockSchema` —
 * десять типов): таблица живёт в HTML блока `text` (санитайзер `11` §3.3 пропускает `table`).
 * Поэтому признак — блок `table` (если он появится) **или** `<table` в HTML текстового блока.
 * Тот же признак считает SQL сервера (`library.ts#bodyStatsSql`, `ilike '%<table%'`).
 */
export function blockIsTable(b: { type: string, html?: unknown }): boolean {
  return b.type === 'table' || (b.type === 'text' && typeof b.html === 'string' && /<table/i.test(b.html))
}

export function bodyStats(blocks: readonly { type: string, html?: unknown }[]): BodyStats {
  return {
    blocks: blocks.length,
    checklists: blocks.filter(b => b.type === 'checklist').length,
    hasTable: blocks.some(blockIsTable),
  }
}

/**
 * Иконка (§7.7): `file` — документ, `video` — плёнка, `link` — цепочка; `article` уточняется
 * доминирующим блоком тела: доля `checklist` ≥ 50 % → чек-лист, иначе есть таблица →
 * таблица, иначе «T». Пустое тело — «T»: доли у пустого тела нет.
 */
export function typeIconOf(contentKind: string, stats: BodyStats | null): LibraryTypeIcon {
  if (contentKind === 'file' || contentKind === 'video' || contentKind === 'link') return contentKind
  if (!stats || stats.blocks === 0) return 'text'
  if (stats.checklists * 2 >= stats.blocks) return 'checklist'
  if (stats.hasTable) return 'table'
  return 'text'
}

// ── Поиск (§7.8, критерий 8) ────────────────────────────────────────────────────────────

/** Слова запроса: буквы и цифры любого алфавита, от двух знаков, не больше восьми. */
export function searchWords(q: string): string[] {
  const words = q.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []
  return [...new Set(words.filter(w => w.length >= 2))].slice(0, LIBRARY_LIMITS.searchWordsMax)
}

/**
 * Полнотекстовый запрос с префиксами (`розвед:* & хім:*`): палитра ищет по мере набора, и
 * недописанное слово тоже должно находиться. В строку попадают только буквы и цифры —
 * операторы `to_tsquery` из пользовательского ввода не пропускаются. Пусто — `null`.
 */
export function prefixTsQuery(q: string): string | null {
  const words = searchWords(q)
  return words.length ? words.map(w => `${w}:*`).join(' & ') : null
}

/** «Запрос длиннее трёх слов уходит в гибрид» (§7.8). */
export function isHybridQuery(q: string): boolean {
  return (q.trim().match(/\S+/g) ?? []).length >= LIBRARY_LIMITS.hybridMinWords
}

/**
 * Reciprocal Rank Fusion (§7.8): у каждого документа — сумма 1 / (k + ранг) по спискам, где он
 * есть (ранг с единицы). Документ, найденный обоими способами, поднимается выше найденного
 * одним; при равенстве — порядок первого списка (полнотекста), затем второго.
 */
export function rrfMerge(lists: readonly (readonly string[])[], limit: number = LIBRARY_LIMITS.searchLimit, k: number = LIBRARY_LIMITS.rrfK): string[] {
  const score = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let order = 0
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
      if (!firstSeen.has(id)) firstSeen.set(id, order++)
    })
  }
  return [...score.keys()]
    .sort((a, b) => (score.get(b)! - score.get(a)!) || (firstSeen.get(a)! - firstSeen.get(b)!))
    .slice(0, limit)
}

// ── Обновление места и хотфикс (§7.3, §7.4, критерии 2 и 6) ─────────────────────────────

export type UpdateVerdict
  = | { ok: true }
    | { ok: false, code: 'already_latest' | 'version_downgrade' | 'version_retired' }

/**
 * Можно ли перевести место с закреплённой версии на целевую (§7.3). Только вперёд: «отката
 * версии нет» (§12) — откат это новая версия с прежним телом. На ту же версию — `already_latest`;
 * на выведенную из оборота (`retired`) — нельзя: её уже никто не закрепляет и не должен.
 */
export function updateVerdict(pinnedVersion: number, target: { version: number, status: string }): UpdateVerdict {
  if (target.version === pinnedVersion) return { ok: false, code: 'already_latest' }
  if (target.version < pinnedVersion) return { ok: false, code: 'version_downgrade' }
  if (target.status === 'retired') return { ok: false, code: 'version_retired' }
  return { ok: true }
}

export type HotfixDecision = 'apply' | 'skip_fixed' | 'skip_newer' | 'blocked_in_progress' | 'blocked_published'

/**
 * Что делает «Критичне виправлення» с одним местом (§7.4, Р-31.4, критерий 6):
 * - `fixed` — хотфикс сам не доезжает (`skip_fixed`), место остаётся устаревшим до явного обновления;
 * - место уже на хотфиксе или новее — делать нечего (`skip_newer`);
 * - по контейнеру есть хоть одно прохождение `in_progress` — не трогаем: человек доучивается на
 *   том, что начал (`blocked_in_progress`, автору — `library_hotfix_blocked`);
 * - держатель в опубликованной версии курса — версия курса неизменяема (`11` §7.1), править
 *   можно только черновик (`blocked_published`, тот же код уведомления);
 * - иначе — применить.
 */
export function hotfixDecision(p: { pinMode: string, pinnedVersion: number, hotfixVersion: number, inProgress: number, holderMutable: boolean }): HotfixDecision {
  if (p.pinnedVersion >= p.hotfixVersion) return 'skip_newer'
  if (p.pinMode !== 'hotfix_auto') return 'skip_fixed'
  if (p.inProgress > 0) return 'blocked_in_progress'
  if (!p.holderMutable) return 'blocked_published'
  return 'apply'
}

/** Changelog пропущенных версий для диалога обновления (§5.5): строго после закреплённой и до целевой включительно, по возрастанию. */
export function skippedVersions<T extends { version: number }>(versions: readonly T[], from: number, to: number): T[] {
  return versions.filter(v => v.version > from && v.version <= to).sort((a, b) => a.version - b.version)
}
