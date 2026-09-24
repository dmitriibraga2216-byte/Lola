import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { userNotes, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { isVisibilityNarrowing, noteRetentionMonths } from '../../shared/domain/personRecords'
import { PERSON_NOTE_LIMITS } from '../../shared/enums'
import type { PersonNoteCategory, PersonNoteVisibility } from '../../shared/enums'
import type { NoteCreateInput, NoteListQuery, NoteUpdateInput } from '../../shared/schemas/personRecords'
import { KEYSETS, encodeKeyset } from '../../shared/domain/keyset'
import { keysetAfter, keysetAt } from '../utils/keyset'
import type { Access } from './access'
import { areaCovers, areaOf, hasTenantGrant } from './access'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { screenNoteText } from './noteScreen'
import type { SensitiveSign } from './noteScreen'
import { EMPLOYEES_ONLY } from './repo/people'
import { cardSubject, isUuid } from './personCard'
import type { CardSubject } from './personCard'

/**
 * Заметки о человеке (docs/v2/38-people-extensions.md §3.4, §4, §7.4–§7.6; PR-32).
 *
 * **Кто что видит (§7.4).** Уровни — `hr` (автор, носители `person.note.read` на весь
 * тенант, администратор), `manager` (то же плюс руководители **текущей** точки человека —
 * при переводе доступ прежнего пропадает в тот же день, заметка не копируется),
 * `shared_with_person` (то же плюс сам человек). Уровня «тільки автор» нет.
 * Сам человек видит счётчик всех своих заметок — существование не скрывается — и только
 * открытые ему. Уволенный (`users.status='archived'`): заметки только для чтения, видимость
 * всех сужается до HR и администратора (§7.6). Архивная по сроку заметка из карточки
 * исчезает и доступна администратору по прямой ссылке.
 *
 * **«Руководитель точки»** — носитель скоупа в области, покрывающей текущую точку человека
 * (роль на точку или на подразделение над ней). Это то же понятие «своих точек», что у
 * отчётов (`scopeForGrants`), а не поле `locations.manager_id`: право читать — вопрос о роли
 * смотрящего, а не о том, кого точка называет руководителем.
 *
 * **Администратор заметок** — носитель `person.note.write` **и** `audit.view` на весь тенант.
 * Отдельного скоупа ТЗ не заводит (новых не выдумываем), а всё, что §7.5–§7.6 и §12 оставляют
 * «только admin» — удалить чужую заметку с причиной, править заметку уволенного автора,
 * открыть архивную по ссылке, — это надзор над журналом, то есть `audit.view`.
 *
 * **Чтение пишет журнал (§7.6, `41` §5.1)** — `person_note.read` с перечнем `note_ids` и без
 * текста: смысл записи «кто открывал заметки об этом человеке», а не копия содержания.
 */

type Area = 'tenant' | 'none' | string[]
interface Ctx { tenantId: string, actorId: string }

export interface NoteViewer {
  userId: string
  read: Area
  write: Area
  /** Надзор: чужая заметка, архив по ссылке, заметка уволенного автора. */
  admin: boolean
  /**
   * Смотрит токен интеграции, а не человек (PR-39, docs/v2/44 В-20): заметки о людях —
   * `sessionOnly`, и «свои открытые заметки без скоупа» (§7.4) токену создателя не достаются.
   */
  viaToken?: boolean
}

export async function noteViewerOf(access: Access): Promise<NoteViewer> {
  return {
    userId: access.userId,
    read: await areaOf(access, 'person.note.read'),
    write: await areaOf(access, 'person.note.write'),
    admin: hasTenantGrant(access, 'person.note.write') && hasTenantGrant(access, 'audit.view'),
    viaToken: access.viaToken === true,
  }
}

type Subject = CardSubject

type ReaderKind = 'subject' | 'tenant' | 'area' | 'author_only' | 'none'

/** Как смотрящий видит заметки этого человека (§7.4). */
function readerKind(v: NoteViewer, s: Subject): ReaderKind {
  if (v.viaToken) return 'none' // заметки о людях — только в сессии человека (docs/v2/44 В-20)
  if (v.userId === s.id) return 'subject'
  if (v.read === 'none') return 'none'
  if (v.read === 'tenant') return 'tenant'
  // Уволенный: только HR и администратор (§7.6) — руководитель точки и автор больше не видят
  if (s.archived) return 'none'
  if (areaCovers(v.read, s.locationId)) return 'area'
  return 'author_only'
}

/** Фильтр неархивных заметок, видимых смотрящему, — одна точка на список, счётчик и карточку. */
function visibleFilter(kind: ReaderKind, v: NoteViewer): SQL | undefined {
  if (kind === 'subject') return sql`${userNotes.visibility} = 'shared_with_person'`
  if (kind === 'tenant') return undefined
  if (kind === 'area') return sql`(${userNotes.visibility} in ('manager', 'shared_with_person') or ${userNotes.authorId} = ${v.userId}::uuid)`
  return sql`${userNotes.authorId} = ${v.userId}::uuid`
}

/** Может ли смотрящий писать о человеке: скоуп в области его текущей точки, не о себе, не об уволенном. */
function writeCovers(v: NoteViewer, s: Subject): boolean {
  return v.userId !== s.id && areaCovers(v.write, s.locationId)
}

type NoteRow = typeof userNotes.$inferSelect & { authorName: string | null, authorStatus: string | null }

export interface NoteDto {
  id: string
  body: string
  category: PersonNoteCategory
  visibility: PersonNoteVisibility
  isPinned: boolean
  flagged: boolean
  flaggedTerms: string[]
  sharedAt: Date | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  author: { id: string, name: string, archived: boolean } | null
  can: { edit: boolean, delete: boolean }
}

function canEdit(v: NoteViewer, s: Subject, n: { authorId: string | null, archivedAt: Date | null }): boolean {
  if (n.archivedAt || s.archived) return false
  return v.admin || (n.authorId === v.userId && writeCovers(v, s))
}

function toDto(n: NoteRow, v: NoteViewer, s: Subject, kind: ReaderKind): NoteDto {
  const edit = kind !== 'subject' && canEdit(v, s, n)
  return {
    id: n.id,
    body: n.body,
    category: n.category as PersonNoteCategory,
    visibility: n.visibility as PersonNoteVisibility,
    isPinned: n.isPinned,
    // Отметка скрина — для надзора, не для самого человека: ему открыли текст, а не наши сомнения
    flagged: kind !== 'subject' && n.flaggedAt != null,
    flaggedTerms: kind !== 'subject' ? n.flaggedTerms : [],
    sharedAt: n.sharedAt,
    archivedAt: n.archivedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: n.authorId ? { id: n.authorId, name: n.authorName ?? '', archived: n.authorStatus === 'archived' } : null,
    // Удалить чужую может только администратор — и архивную, и заметку уволенного (с причиной)
    can: { edit, delete: kind !== 'subject' && (edit || v.admin) },
  }
}

/**
 * То же правило видимости, что `visibleFilter`, для одной уже загруженной строки (карточка,
 * правка, удаление). Архивная — только администратору (§7.6).
 */
function visibleTo(kind: ReaderKind, v: NoteViewer, n: { visibility: string, authorId: string | null, archivedAt: Date | null }): boolean {
  if (n.archivedAt) return v.admin && kind === 'tenant'
  if (kind === 'subject') return n.visibility === 'shared_with_person'
  if (kind === 'tenant') return true
  if (kind === 'area') return n.visibility !== 'hr' || n.authorId === v.userId
  if (kind === 'author_only') return n.authorId === v.userId
  return false
}

/** Ключ ленты — `is_pinned desc, created_at desc, id desc` (`KEYSETS.personNotes`). */
const FEED_KEY = [sql`${userNotes.isPinned}::int`, userNotes.createdAt, userNotes.id] as const

type NoteRowPaged = NoteRow & { cursorAt: string }

/** Заметки с именем автора. `left join` — обогащение именем, людей в выборку он не добавляет. */
async function loadNotes(tx: TenantTx, where: SQL | undefined, page?: { cursor?: string, limit: number }): Promise<NoteRowPaged[]> {
  const q = tx.select({
    note: userNotes,
    authorName: users.fullName,
    authorStatus: users.status,
    cursorAt: keysetAt(userNotes.createdAt),
  }).from(userNotes)
    .leftJoin(users, eq(users.id, userNotes.authorId))
    .where(and(where, page ? keysetAfter(KEYSETS.personNotes, page.cursor, FEED_KEY, 'desc') : undefined))
    .orderBy(desc(userNotes.isPinned), desc(userNotes.createdAt), desc(userNotes.id))
  const rows = page ? await q.limit(page.limit + 1) : await q
  return rows.map(r => ({ ...r.note, authorName: r.authorName, authorStatus: r.authorStatus, cursorAt: r.cursorAt }))
}

export type NotesListResult
  = | { ok: true, items: NoteDto[], total: number, canCreate: boolean, cursor: string | null }
    | { ok: false, code: 'not_found' | 'forbidden' }

/**
 * Лента заметок карточки (§5.1), страницами с ключевым курсором (docs/04 §4.1). **Пишет
 * `person_note.read`** — одна запись на разворот секции и на каждую следующую страницу, с
 * перечнем показанных `note_ids` и без текста (§7.6). Архивных в ленте нет. `total` — число в
 * заголовке «Нотатки (N)»: смотрящему — видимые ему, самому человеку — все его неархивные
 * заметки (существование не скрывается, §7.4).
 */
export async function listPersonNotes(ctx: Ctx, v: NoteViewer, personId: string, page: NoteListQuery = { limit: 30 }): Promise<NotesListResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const kind = readerKind(v, s)
    if (kind === 'none') return { ok: false, code: 'forbidden' }

    const base = and(eq(userNotes.userId, s.id), isNull(userNotes.archivedAt))
    const rows = await loadNotes(tx, and(base, visibleFilter(kind, v)), { cursor: page.cursor || undefined, limit: page.limit })
    const shown = rows.slice(0, page.limit)
    const last = rows.length > page.limit ? shown[shown.length - 1] : undefined
    const total = await countWhere(tx, kind === 'subject' ? base : and(base, visibleFilter(kind, v)))

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'person_note.read',
      entity: 'user',
      entityId: s.id,
      after: { user_id: s.id, note_ids: shown.map(r => r.id), count: shown.length },
    })
    return {
      ok: true,
      items: shown.map(r => toDto(r, v, s, kind)),
      total,
      canCreate: kind !== 'subject' && !s.archived && writeCovers(v, s),
      cursor: last ? encodeKeyset(KEYSETS.personNotes, [last.isPinned ? 1 : 0, last.cursorAt, last.id]) : null,
    }
  })
}

async function countWhere(tx: TenantTx, where: SQL | undefined): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(userNotes).where(where)
  return r?.n ?? 0
}

/** Число для свёрнутой секции «Нотатки (N)» — без чтения содержания, поэтому без журнала. */
export async function countPersonNotes(ctx: Ctx, v: NoteViewer, personId: string): Promise<{ ok: true, total: number, canCreate: boolean } | { ok: false, code: 'not_found' | 'forbidden' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const kind = readerKind(v, s)
    if (kind === 'none') return { ok: false, code: 'forbidden' }
    const base = and(eq(userNotes.userId, s.id), isNull(userNotes.archivedAt))
    const total = await countWhere(tx, kind === 'subject' ? base : and(base, visibleFilter(kind, v)))
    return { ok: true, total, canCreate: kind !== 'subject' && !s.archived && writeCovers(v, s) }
  })
}

/**
 * Заметка по прямой ссылке. Неархивная — тем же правилам, что лента; архивная — только
 * администратору (§7.6, критерий §13 п. 6). Чтение пишется в журнал так же, как лента.
 * Невидимая заметка — `404`, а не `403`: её существование смотрящему не подтверждается.
 */
export async function getPersonNote(ctx: Ctx, v: NoteViewer, personId: string, noteId: string): Promise<{ ok: true, note: NoteDto } | { ok: false, code: 'not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const kind = readerKind(v, s)
    if (!isUuid(noteId)) return { ok: false, code: 'not_found' }
    const [row] = await loadNotes(tx, and(eq(userNotes.id, noteId), eq(userNotes.userId, s.id)))
    if (!row || !visibleTo(kind, v, row)) return { ok: false, code: 'not_found' }
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'person_note.read',
      entity: 'user',
      entityId: s.id,
      after: { user_id: s.id, note_ids: [row.id], count: 1 },
    })
    return { ok: true, note: toDto(row, v, s, kind) }
  })
}

export type NoteWriteError
  = | { ok: false, code: 'not_found' | 'forbidden' | 'person_archived' | 'note_archived' | 'pinned_limit' | 'visibility_narrowing_forbidden' | 'reason_required' }
    | { ok: false, code: 'sensitive', signs: SensitiveSign[], terms: string[] }

/** Не больше трёх закреплённых на человека (§3.4). Блокировка — чтобы два клика не дали четвёртую. */
async function pinnedLimitReached(tx: TenantTx, personId: string, exceptNoteId?: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`user_notes:pin:${personId}`}))`)
  const [r] = await tx.execute(sql`
    select count(*)::int as n from user_notes
    where user_id = ${personId}::uuid and is_pinned and archived_at is null
      ${exceptNoteId ? sql`and id <> ${exceptNoteId}::uuid` : sql``}`) as unknown as { n: number }[]
  return (r?.n ?? 0) >= PERSON_NOTE_LIMITS.pinnedMax
}

/** Администраторы заметок — адресаты `person_note_flagged` (§8: «внутреннее, admin»). */
async function noteAdmins(tx: TenantTx, exceptUserId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct ur.user_id from user_roles ur
    join roles r on r.id = ur.role_id
    join users u on u.id = ur.user_id
    where ur.scope_type = 'tenant' and r.scopes @> array['person.note.write', 'audit.view']::text[]
      and (ur.valid_until is null or ur.valid_until > now())
      and u.status = 'active' and not u.is_blocked and ur.user_id <> ${exceptUserId}::uuid
      ${EMPLOYEES_ONLY('u')}`) as unknown as { user_id: string }[]
  return rows.map(r => r.user_id)
}

async function notifyFlagged(tx: TenantTx, ctx: Ctx, noteId: string, s: Subject): Promise<void> {
  for (const adminId of await noteAdmins(tx, ctx.actorId)) {
    await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: adminId, code: 'person_note_flagged', payload: { person: s.fullName }, dedupKey: `person_note_flagged:${noteId}:${adminId}`, refType: 'user', refId: s.id })
  }
}

async function notifyShared(tx: TenantTx, ctx: Ctx, noteId: string, s: Subject): Promise<void> {
  await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: s.id, code: 'person_note_shared', payload: {}, dedupKey: `person_note_shared:${noteId}`, refType: 'user', refId: s.id })
}

/**
 * «Додати нотатку» (§6.1). Скрин чувствительного содержания (§7.5) **не блокирует**: при
 * срабатывании без `confirmSensitive` ответ — `sensitive` с признаками, форма показывает
 * «Текст схожий на чутливі дані…» с кнопками «Змінити текст» / «Все одно зберегти»;
 * повтор с `confirmSensitive` сохраняет и ставит `flagged_at`.
 */
export async function createPersonNote(ctx: Ctx, v: NoteViewer, personId: string, input: NoteCreateInput): Promise<{ ok: true, note: NoteDto } | NoteWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    if (!writeCovers(v, s)) return { ok: false, code: 'forbidden' }
    if (s.archived) return { ok: false, code: 'person_archived' }
    if (input.isPinned && await pinnedLimitReached(tx, s.id)) return { ok: false, code: 'pinned_limit' }

    const screen = screenNoteText(input.body)
    if (screen.signs.length && !input.confirmSensitive) return { ok: false, code: 'sensitive', ...screen }

    const now = new Date()
    const [row] = await tx.insert(userNotes).values({
      tenantId: ctx.tenantId,
      userId: s.id,
      authorId: ctx.actorId,
      body: input.body,
      category: input.category,
      visibility: input.visibility,
      isPinned: input.isPinned,
      flaggedAt: screen.signs.length ? now : null,
      flaggedTerms: screen.terms,
      sharedAt: input.visibility === 'shared_with_person' ? now : null,
    }).returning()

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_note.create', entity: 'user_notes', entityId: row!.id, after: row })
    if (input.visibility === 'shared_with_person') {
      await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_note.share', entity: 'user_notes', entityId: row!.id, after: { visibility: 'shared_with_person', sharedAt: now } })
      await notifyShared(tx, ctx, row!.id, s)
    }
    if (screen.signs.length) await notifyFlagged(tx, ctx, row!.id, s)

    const [full] = await loadNotes(tx, eq(userNotes.id, row!.id))
    return { ok: true, note: toDto(full!, v, s, readerKind(v, s)) }
  })
}

/**
 * Правка заметки (§10). Своя — автору, пока у него есть право писать о человеке; любая —
 * администратору (§12: заметку уволенного автора правит только он). Видимость меняется в обе
 * стороны, **кроме** `shared_with_person → manager|hr` (§4): открытое человеку он уже
 * прочитал — `409 visibility_narrowing_forbidden`, критерий §13 п. 5.
 */
export async function updatePersonNote(ctx: Ctx, v: NoteViewer, personId: string, noteId: string, input: NoteUpdateInput): Promise<{ ok: true, note: NoteDto } | NoteWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const kind = readerKind(v, s)
    if (!isUuid(noteId)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select().from(userNotes).where(and(eq(userNotes.id, noteId), eq(userNotes.userId, s.id))).for('update')
    if (!cur || kind === 'subject' || !visibleTo(kind, v, cur)) return { ok: false, code: 'not_found' }
    if (s.archived) return { ok: false, code: 'person_archived' }
    if (cur.archivedAt) return { ok: false, code: 'note_archived' }
    if (!canEdit(v, s, cur)) return { ok: false, code: 'forbidden' }

    const from = cur.visibility as PersonNoteVisibility
    const to = input.visibility ?? from
    if (isVisibilityNarrowing(from, to)) return { ok: false, code: 'visibility_narrowing_forbidden' }
    if (input.isPinned && !cur.isPinned && await pinnedLimitReached(tx, s.id, cur.id)) return { ok: false, code: 'pinned_limit' }

    const now = new Date()
    const patch: Partial<typeof userNotes.$inferInsert> = { updatedAt: now }
    if (input.body !== undefined && input.body !== cur.body) {
      const screen = screenNoteText(input.body)
      if (screen.signs.length && !input.confirmSensitive) return { ok: false, code: 'sensitive', ...screen }
      patch.body = input.body
      // Переписанный текст скринится заново: убрал чувствительное — отметка снимается
      patch.flaggedAt = screen.signs.length ? now : null
      patch.flaggedTerms = screen.terms
    }
    if (input.category !== undefined) patch.category = input.category
    if (input.isPinned !== undefined) patch.isPinned = input.isPinned
    if (to !== from) {
      patch.visibility = to
      if (to === 'shared_with_person') patch.sharedAt = cur.sharedAt ?? now
    }
    const [row] = await tx.update(userNotes).set(patch).where(eq(userNotes.id, cur.id)).returning()

    const changed = Object.keys(patch).filter(k => k !== 'updatedAt' && k !== 'visibility' && k !== 'sharedAt')
    if (changed.length) {
      await recordAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: 'person_note.update',
        entity: 'user_notes',
        entityId: cur.id,
        before: Object.fromEntries(changed.map(k => [k, cur[k as keyof typeof cur]])),
        after: Object.fromEntries(changed.map(k => [k, row![k as keyof typeof row]])),
      })
    }
    if (to !== from) {
      await recordAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: to === 'shared_with_person' ? 'person_note.share' : 'person_note.visibility_change',
        entity: 'user_notes',
        entityId: cur.id,
        before: { visibility: from },
        after: { visibility: to, ...(to === 'shared_with_person' ? { sharedAt: row!.sharedAt } : {}) },
      })
      if (to === 'shared_with_person') await notifyShared(tx, ctx, cur.id, s)
    }
    if (patch.flaggedAt) await notifyFlagged(tx, ctx, cur.id, s)

    const [full] = await loadNotes(tx, eq(userNotes.id, cur.id))
    return { ok: true, note: toDto(full!, v, s, kind) }
  })
}

/**
 * Удаление (§2, §10): свою — автору, чужую — только администратору и только с причиной
 * (§7.5: «удаление — его решение с причиной»). Физически: заметка — свободный текст о
 * человеке, «мягко удалённая» она продолжала бы жить без смысла. След — `person_note.delete`
 * с прежней строкой целиком (как `create` пишет `after` целиком, §7.6).
 */
export async function deletePersonNote(ctx: Ctx, v: NoteViewer, personId: string, noteId: string, reason?: string): Promise<{ ok: true } | NoteWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const kind = readerKind(v, s)
    if (!isUuid(noteId)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select().from(userNotes).where(and(eq(userNotes.id, noteId), eq(userNotes.userId, s.id))).for('update')
    if (!cur || kind === 'subject' || !visibleTo(kind, v, cur)) return { ok: false, code: 'not_found' }
    const own = cur.authorId === v.userId && writeCovers(v, s) && !cur.archivedAt && !s.archived
    if (!own && !v.admin) return { ok: false, code: 'forbidden' }
    if (!own && !reason) return { ok: false, code: 'reason_required' }

    await tx.delete(userNotes).where(eq(userNotes.id, cur.id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_note.delete', entity: 'user_notes', entityId: cur.id, before: cur, after: { reason: reason ?? null } })
    return { ok: true }
  })
}

/**
 * `notes.archive_scan` (§11, ежесуточно 02:00): `archived_at` по сроку хранения §7.6 —
 * 24 месяца для `general`, `onboarding`, `performance`, `incident`; 36 — для `training_plan`,
 * `agreement` и любой закреплённой. Архивная заметка не удаляется: из карточки она исчезает,
 * администратору доступна по прямой ссылке, след — `person_note.archive` на каждую.
 */
export async function archiveNotesTenant(tenantId: string, now = new Date()): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const short = PERSON_NOTE_LIMITS.retentionMonths
    const long = PERSON_NOTE_LIMITS.retentionMonthsLong
    const at = now.toISOString()
    const rows = await tx.execute(sql`
      update user_notes set archived_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      where archived_at is null and (
        (not is_pinned and category not in ('training_plan', 'agreement') and created_at < ${at}::timestamptz - make_interval(months => ${short}))
        or ((is_pinned or category in ('training_plan', 'agreement')) and created_at < ${at}::timestamptz - make_interval(months => ${long}))
      )
      returning id, user_id, category, is_pinned`) as unknown as { id: string, user_id: string, category: PersonNoteCategory, is_pinned: boolean }[]
    for (const r of rows) {
      await recordAudit(tx, {
        tenantId,
        actorId: null,
        action: 'person_note.archive',
        entity: 'user_notes',
        entityId: r.id,
        after: { userId: r.user_id, archivedAt: now, category: r.category, isPinned: r.is_pinned, retentionMonths: noteRetentionMonths(r.category, r.is_pinned) },
      })
    }
    return rows.length
  })
}
