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
