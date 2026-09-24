import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { mediaAssets, personDocumentTypes, personDocuments, tenants, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import {
  daysBetween, documentFileAllowed, documentReminderDue, documentRequiredFor, documentRetentionUntil, documentStatusBy,
  documentTypeIsSingular, maskDocumentNumber, newerDocumentWins, validateDocumentDates,
} from '../../shared/domain/personRecords'
import type { DocumentDatesError, IsoDate } from '../../shared/domain/personRecords'
import type { PersonDocumentStatus } from '../../shared/enums'
import type {
  DocumentCreateInput, DocumentTypeCreateInput, DocumentTypeUpdateInput, DocumentUpdateInput,
} from '../../shared/schemas/personRecords'
import type { Access } from './access'
import { areaCovers, areaOf, hasTenantGrant } from './access'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import { managerIdOf } from './orgManager'
import { cardSubject, isUuid } from './personCard'
import type { CardSubject } from './personCard'
import { EMPLOYEES_ONLY } from './repo/people'

/**
 * Документы человека (docs/v2/38-people-extensions.md §3.5, §4, §6.2, §7.7, §7.8; PR-32).
 *
 * **Права (§2).** Свои документы человек видит все; чужие — носитель
 * `person.document.view_others`: на весь тенант (HR) — любых типов, в области своей точки
 * (руководитель) — только типов `visible_to_manager`. Загрузить себе — только тип
 * `self_upload` (документ помечается «Завантажено співробітником», источник не проверен);
 * другому, править срок, отменить, удалить — `person.document.manage` по тем же правилам
 * области. Справочник типов правит только HR — `person.document.manage` на весь тенант.
 *
 * **Факт, а не содержание (§7.7).** Тип `is_fact_only` файла не принимает на уровне API —
 * `422 document_file_not_allowed`, запись не создаётся (критерий §13 п. 7). Номер хранится
 * последними четырьмя знаками.
 *
 * **Один действующий (§4).** Новый документ типа-«состояния» (обязательного или со сроком)
 * отменяет прежний с отметкой «Замінено документом від {дата}»; историческая запись, внесённая
 * после текущей, сама становится заменённой — действующим остаётся более свежий.
 */

type Area = 'tenant' | 'none' | string[]
interface Ctx { tenantId: string, actorId: string }

export interface DocViewer {
  userId: string
  view: Area
  manage: Area
  /** Справочник типов — только HR: `person.document.manage` на весь тенант (§2). */
  typesAdmin: boolean
}

export async function docViewerOf(access: Access): Promise<DocViewer> {
  return {
    userId: access.userId,
    view: await areaOf(access, 'person.document.view_others'),
    manage: await areaOf(access, 'person.document.manage'),
    typesAdmin: hasTenantGrant(access, 'person.document.manage'),
  }
}

type TypeRow = typeof personDocumentTypes.$inferSelect
type DocRow = typeof personDocuments.$inferSelect

/** Видит ли смотрящий документы этого типа у этого человека (§2). */
function canView(v: DocViewer, s: CardSubject, t: Pick<TypeRow, 'visibleToManager'>): boolean {
  if (v.userId === s.id) return true
  if (v.view === 'tenant' || v.manage === 'tenant') return true
  return t.visibleToManager && (areaCovers(v.view, s.locationId) || areaCovers(v.manage, s.locationId))
}

/** Может ли загружать, править и отменять документы этого типа этому человеку (§2). */
function canManage(v: DocViewer, s: CardSubject, t: Pick<TypeRow, 'visibleToManager'>): boolean {
  if (v.manage === 'tenant') return true
  return t.visibleToManager && areaCovers(v.manage, s.locationId)
}

/** Может ли добавить документ этого типа: управляющий — любой активный, сам человек — `self_upload`. */
function canCreate(v: DocViewer, s: CardSubject, t: Pick<TypeRow, 'visibleToManager' | 'selfUpload' | 'isActive'>): boolean {
  if (!t.isActive) return false
  if (canManage(v, s, t) && v.userId !== s.id) return true
  return v.userId === s.id && (t.selfUpload || v.manage === 'tenant')
}

/** Дата «сегодня» по часовому поясу тенанта: документы живут датами, полночь — местная. */
async function tenantToday(tx: TenantTx, tenantId: string, now = new Date()): Promise<IsoDate> {
  const [t] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId))
  return localDate(now, t?.timezone ?? 'Europe/Kyiv')
}

export function localDate(now: Date, timezone: string): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export interface DocDto {
  id: string
  typeId: string
  type: { code: string, name: string, isFactOnly: boolean, isRequired: boolean }
  title: string | null
  numberMasked: string | null
  issuedAt: string | null
  expiresAt: string | null
  status: PersonDocumentStatus
  uploadedBy: { id: string, name: string } | null
  /** Загружено самим человеком — источник не проверен HR (§7.8). */
  selfUploaded: boolean
  note: string | null
  createdAt: Date
  revokedAt: Date | null
  revokeReason: string | null
  replacedBy: { id: string, issuedAt: string | null } | null
  file: { mime: string, name: string, bytes: number } | null
  can: { edit: boolean, delete: boolean }
}

interface DocJoined { doc: DocRow, type: TypeRow, uploaderName: string | null, file: { mime: string, name: string, bytes: number } | null, replacedIssuedAt: string | null }

async function loadDocs(tx: TenantTx, where: ReturnType<typeof and>): Promise<DocJoined[]> {
  const rows = await tx.select({
    doc: personDocuments,
    type: personDocumentTypes,
    uploaderName: users.fullName,
    fileMime: mediaAssets.mime,
    fileName: mediaAssets.originalName,
    fileBytes: mediaAssets.bytes,
    fileDeletedAt: mediaAssets.deletedAt,
  }).from(personDocuments)
    .innerJoin(personDocumentTypes, eq(personDocumentTypes.id, personDocuments.typeId))
    // Обогащение именем загрузившего: людей в выборку `left join` не добавляет
    .leftJoin(users, eq(users.id, personDocuments.uploadedBy))
    .leftJoin(mediaAssets, eq(mediaAssets.id, personDocuments.mediaId))
    .where(where)
    .orderBy(asc(personDocumentTypes.name), desc(personDocuments.issuedAt), desc(personDocuments.createdAt))
  const replacedIds = [...new Set(rows.map(r => r.doc.replacedById).filter((x): x is string => !!x))]
  const replaced = replacedIds.length
    ? new Map((await tx.select({ id: personDocuments.id, issuedAt: personDocuments.issuedAt }).from(personDocuments).where(inArray(personDocuments.id, replacedIds))).map(r => [r.id, r.issuedAt]))
    : new Map<string, string | null>()
  return rows.map(r => ({
    doc: r.doc,
    type: r.type,
    uploaderName: r.uploaderName,
    file: r.fileMime && !r.fileDeletedAt ? { mime: r.fileMime, name: r.fileName ?? '', bytes: r.fileBytes ?? 0 } : null,
    replacedIssuedAt: r.doc.replacedById ? replaced.get(r.doc.replacedById) ?? null : null,
  }))
}

function toDto(j: DocJoined, v: DocViewer, s: CardSubject): DocDto {
  const { doc, type } = j
  const manage = v.userId !== s.id && canManage(v, s, type)
  return {
    id: doc.id,
    typeId: doc.typeId,
    type: { code: type.code, name: type.name, isFactOnly: type.isFactOnly, isRequired: type.isRequired },
    title: doc.title,
    numberMasked: doc.numberMasked,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
    status: doc.status as PersonDocumentStatus,
    uploadedBy: { id: doc.uploadedBy, name: j.uploaderName ?? '' },
    selfUploaded: doc.uploadedBy === doc.userId,
    note: doc.note,
    createdAt: doc.createdAt,
    revokedAt: doc.revokedAt,
    revokeReason: doc.revokeReason,
    replacedBy: doc.replacedById ? { id: doc.replacedById, issuedAt: j.replacedIssuedAt } : null,
    file: j.file,
    // Обязательный — доказательство, его не удаляют, а отменяют (`409 document_is_evidence`)
    can: { edit: manage, delete: manage && !type.isRequired },
  }
}

export interface DocTypeOption { id: string, code: string, name: string, isFactOnly: boolean, validityMonths: number | null, isRequired: boolean }

export type DocsListResult
  = | { ok: true, items: DocDto[], missing: { typeId: string, code: string, name: string }[], total: number, types: DocTypeOption[] }
    | { ok: false, code: 'not_found' | 'forbidden' }

/**
 * Блок «Документи (N)» (§5.1): документы, видимые смотрящему; строки-заглушки для
 * отсутствующих обязательных типов, подходящих посадам человека (иначе отсутствие документа
 * невидимо, §7.8); типы, которые смотрящий вправе добавить этому человеку, — для формы §6.2.
 * `total` — действующие (не отменённые) документы.
 */
export async function listPersonDocuments(ctx: Ctx, v: DocViewer, personId: string): Promise<DocsListResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const self = v.userId === s.id
    const anyRight = self || v.view === 'tenant' || v.manage === 'tenant'
      || areaCovers(v.view, s.locationId) || areaCovers(v.manage, s.locationId)
    if (!anyRight) return { ok: false, code: 'forbidden' }

    const rows = (await loadDocs(tx, and(eq(personDocuments.userId, s.id)))).filter(j => canView(v, s, j.type))
    const items = rows.map(j => toDto(j, v, s))
    const types = await tx.select().from(personDocumentTypes).orderBy(asc(personDocumentTypes.name))
    const present = new Set(rows.filter(j => j.doc.status !== 'revoked').map(j => j.type.id))
    const missing = types
      .filter(t => canView(v, s, t) && !present.has(t.id) && documentRequiredFor(t, s.positionIds))
      .map(t => ({ typeId: t.id, code: t.code, name: t.name }))
    const creatable = types
      .filter(t => canCreate(v, s, t))
      .map(t => ({ id: t.id, code: t.code, name: t.name, isFactOnly: t.isFactOnly, validityMonths: t.validityMonths, isRequired: t.isRequired }))
    return { ok: true, items, missing, total: items.filter(i => i.status !== 'revoked').length, types: creatable }
  })
}

export type DocWriteError
  = | { ok: false, code: 'not_found' | 'forbidden' | 'document_type_invalid' | 'document_file_not_allowed' | 'document_file_required' | 'document_file_invalid' | 'document_file_not_ready' | 'document_revoked' | 'document_is_evidence' | 'reason_required' }
    | { ok: false, code: 'document_dates_invalid', reason: DocumentDatesError }

/** Файл, который можно приложить: свой, `origin='person_document'`, дошедший до хранилища и ещё ничей. */
async function checkMedia(tx: TenantTx, ctx: Ctx, mediaId: string): Promise<{ ok: true } | DocWriteError> {
  const [m] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))
  if (!m || m.deletedAt) return { ok: false, code: 'not_found' } // чужой тенант — 404 (CLAUDE.md п. 15)
  if (m.origin !== 'person_document' || m.ownerUserId !== ctx.actorId) return { ok: false, code: 'document_file_invalid' }
  if (!documentFileAllowed(m.mime, m.bytes)) return { ok: false, code: 'document_file_invalid' }
  const [attached] = await tx.select({ id: personDocuments.id }).from(personDocuments).where(eq(personDocuments.mediaId, mediaId))
  if (attached) return { ok: false, code: 'document_file_invalid' }
  if (m.status === 'uploading' || m.status === 'failed') return { ok: false, code: 'document_file_not_ready' }
  return { ok: true }
}

/**
 * «Додати документ» (§6.2). Порядок проверок повторяет форму: тип → право → файл → даты.
 * Тип «лише факт» с файлом — `422 document_file_not_allowed` **до** любой записи: ни строки
 * документа, ни привязки файла не появляется (критерий §13 п. 7).
 */
export async function createPersonDocument(ctx: Ctx, v: DocViewer, personId: string, input: DocumentCreateInput): Promise<{ ok: true, document: DocDto, warnings: string[] } | DocWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s) return { ok: false, code: 'not_found' }
    const [type] = await tx.select().from(personDocumentTypes).where(eq(personDocumentTypes.id, input.typeId))
    if (!type || !type.isActive) return { ok: false, code: 'document_type_invalid' }
    if (!canCreate(v, s, type)) return { ok: false, code: 'forbidden' }

    if (type.isFactOnly && input.mediaId) return { ok: false, code: 'document_file_not_allowed' }
    if (!type.isFactOnly && !input.mediaId) return { ok: false, code: 'document_file_required' }

    const today = await tenantToday(tx, ctx.tenantId)
    const expiresAt = input.expiresAt ?? null
    const datesError = validateDocumentDates({ issuedAt: input.issuedAt, expiresAt }, today, type.validityMonths)
    if (datesError) return { ok: false, code: 'document_dates_invalid', reason: datesError }
    if (input.mediaId) {
      const media = await checkMedia(tx, ctx, input.mediaId)
      if (!media.ok) return media
    }

    const status = documentStatusBy(expiresAt, today, type.remindDays)
    const now = new Date()
    const [doc] = await tx.insert(personDocuments).values({
      tenantId: ctx.tenantId,
      userId: s.id,
      typeId: type.id,
      mediaId: input.mediaId ?? null,
      title: input.title || null,
      numberMasked: maskDocumentNumber(input.number),
      issuedAt: input.issuedAt,
      expiresAt,
      status,
      uploadedBy: ctx.actorId,
      note: input.note || null,
    }).returning()

    // Один действующий документ типа-«состояния» (§4): кто свежее по дате выдачи, тот и остаётся
    if (documentTypeIsSingular(type)) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`person_documents:${s.id}:${type.id}`}))`)
      const others = await tx.select().from(personDocuments).where(and(
        eq(personDocuments.userId, s.id), eq(personDocuments.typeId, type.id),
        ne(personDocuments.status, 'revoked'), ne(personDocuments.id, doc!.id),
      ))
      let winner = doc!
      for (const prev of others) if (newerDocumentWins(prev.issuedAt, winner.issuedAt!) === 'existing') winner = prev
      for (const loser of [doc!, ...others].filter(d => d.id !== winner.id)) {
        await tx.update(personDocuments).set({ status: 'revoked', revokedAt: now, replacedById: winner.id, updatedAt: now }).where(eq(personDocuments.id, loser.id))
        await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_document.revoke', entity: 'person_documents', entityId: loser.id, before: { status: loser.status }, after: { status: 'revoked', replacedById: winner.id } })
      }
    }

    if (input.mediaId) {
      // Файл становится файлом человека (`34` §7.1): владелец — тот, о ком документ; доказательство
      // для обязательных типов (`34` §7.2) и срок хранения `expires_at + 3 роки` (§7.8)
      const retention = documentRetentionUntil(expiresAt)
      await tx.update(mediaAssets).set({
        ownerUserId: s.id,
        sourceEntity: 'person_documents',
        sourceId: doc!.id,
        isEvidence: type.isRequired,
        retentionUntil: retention ? new Date(`${retention}T00:00:00Z`) : null,
        updatedAt: now,
      }).where(eq(mediaAssets.id, input.mediaId))
    }

    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_document.create', entity: 'person_documents', entityId: doc!.id, after: { ...doc, typeCode: type.code } })
    const [joined] = await loadDocs(tx, and(eq(personDocuments.id, doc!.id)))
    return { ok: true, document: toDto(joined!, v, s), warnings: status === 'expired' ? ['already_expired'] : [] }
  })
}

/**
 * Правка (§10): срок, отмена, примечание. Отмена необратима и только с причиной (§4); у
 * отменённого документа меняется лишь примечание. Смена срока пересчитывает состояние и
 * срок хранения файла.
 */
export async function updatePersonDocument(ctx: Ctx, v: DocViewer, personId: string, docId: string, input: DocumentUpdateInput): Promise<{ ok: true, document: DocDto } | DocWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s || !isUuid(docId)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select({ doc: personDocuments, type: personDocumentTypes }).from(personDocuments)
      .innerJoin(personDocumentTypes, eq(personDocumentTypes.id, personDocuments.typeId))
      .where(and(eq(personDocuments.id, docId), eq(personDocuments.userId, s.id))).for('update', { of: personDocuments })
    if (!cur || !canView(v, s, cur.type)) return { ok: false, code: 'not_found' }
    if (v.userId === s.id || !canManage(v, s, cur.type)) return { ok: false, code: 'forbidden' }
    const { doc, type } = cur
    const revoked = doc.status === 'revoked'
    if (revoked && (input.expiresAt !== undefined || input.status !== undefined)) return { ok: false, code: 'document_revoked' }
    if (input.status === 'revoked' && !input.reason) return { ok: false, code: 'reason_required' }

    const now = new Date()
    const patch: Partial<typeof personDocuments.$inferInsert> = { updatedAt: now }
    if (input.note !== undefined) patch.note = input.note || null
    if (input.expiresAt !== undefined && input.expiresAt !== doc.expiresAt) {
      const today = await tenantToday(tx, ctx.tenantId)
      if (!input.expiresAt && type.validityMonths) return { ok: false, code: 'document_dates_invalid', reason: 'expires_required' }
      if (input.expiresAt && doc.issuedAt && daysBetween(doc.issuedAt, input.expiresAt) <= 0) return { ok: false, code: 'document_dates_invalid', reason: 'expires_before_issued' }
      patch.expiresAt = input.expiresAt
      patch.status = documentStatusBy(input.expiresAt, today, type.remindDays)
      if (doc.mediaId) {
        const retention = documentRetentionUntil(input.expiresAt)
        await tx.update(mediaAssets).set({ retentionUntil: retention ? new Date(`${retention}T00:00:00Z`) : null, updatedAt: now }).where(eq(mediaAssets.id, doc.mediaId))
      }
    }
    if (input.status === 'revoked') {
      patch.status = 'revoked'
      patch.revokedAt = now
      patch.revokeReason = input.reason!
    }
    const [row] = await tx.update(personDocuments).set(patch).where(eq(personDocuments.id, doc.id)).returning()
    const changed = Object.keys(patch).filter(k => k !== 'updatedAt')
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: input.status === 'revoked' ? 'person_document.revoke' : 'person_document.update',
      entity: 'person_documents',
      entityId: doc.id,
      before: Object.fromEntries(changed.map(k => [k, doc[k as keyof DocRow]])),
      after: Object.fromEntries(changed.map(k => [k, row![k as keyof DocRow]])),
    })
    const [joined] = await loadDocs(tx, and(eq(personDocuments.id, doc.id)))
    return { ok: true, document: toDto(joined!, v, s) }
  })
}

/**
 * Удаление (§10). Документ обязательного типа — доказательство того, что инструктаж когда-то
 * был проведён (§3.2, §7.8): его не удаляют, а отменяют — `409 document_is_evidence`.
 * Файл остального уходит в корзину тем же мягким удалением, что `DELETE /media/:id`.
 */
export async function deletePersonDocument(ctx: Ctx, v: DocViewer, personId: string, docId: string): Promise<{ ok: true, mediaId: string | null } | DocWriteError> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s || !isUuid(docId)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select({ doc: personDocuments, type: personDocumentTypes }).from(personDocuments)
      .innerJoin(personDocumentTypes, eq(personDocumentTypes.id, personDocuments.typeId))
      .where(and(eq(personDocuments.id, docId), eq(personDocuments.userId, s.id)))
    if (!cur || !canView(v, s, cur.type)) return { ok: false, code: 'not_found' }
    if (v.userId === s.id || !canManage(v, s, cur.type)) return { ok: false, code: 'forbidden' }
    if (cur.type.isRequired) return { ok: false, code: 'document_is_evidence' }

    // Ссылки «заменён этим» на удаляемый документ снимает сам ключ (`on delete set null`)
    await tx.delete(personDocuments).where(eq(personDocuments.id, cur.doc.id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_document.delete', entity: 'person_documents', entityId: cur.doc.id, before: { ...cur.doc, typeCode: cur.type.code } })
    return { ok: true, mediaId: cur.doc.mediaId }
  })
}

/** Файл документа для подписанной ссылки — тем же правам, что сам документ (§2). */
export async function personDocumentFile(ctx: Ctx, v: DocViewer, personId: string, docId: string): Promise<{ ok: true, media: typeof mediaAssets.$inferSelect } | { ok: false, code: 'not_found' }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const s = await cardSubject(tx, personId)
    if (!s || !isUuid(docId)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select({ doc: personDocuments, type: personDocumentTypes, media: mediaAssets }).from(personDocuments)
      .innerJoin(personDocumentTypes, eq(personDocumentTypes.id, personDocuments.typeId))
      .innerJoin(mediaAssets, eq(mediaAssets.id, personDocuments.mediaId))
      .where(and(eq(personDocuments.id, docId), eq(personDocuments.userId, s.id)))
    if (!cur || cur.media.deletedAt || !canView(v, s, cur.type)) return { ok: false, code: 'not_found' }
    return { ok: true, media: cur.media }
  })
}

// ── Справочник типов (`38` §3.5, CRUD `/person-document-types`) ─────────────────────────

export interface DocTypeDto extends TypeRow { documentsCount: number }

/**
 * Типы для экрана справочника и формы. HR (управление на весь тенант или просмотр на весь
 * тенант) видит все, включая выключенные; руководитель — активные `visible_to_manager`;
 * остальные — активные `self_upload`, то есть ровно то, что могут загрузить себе.
 */
export async function listDocumentTypes(ctx: Ctx, v: DocViewer): Promise<DocTypeDto[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select({
      type: personDocumentTypes,
      documentsCount: sql<number>`(select count(*)::int from person_documents d where d.type_id = ${personDocumentTypes.id} and d.status <> 'revoked')`,
    }).from(personDocumentTypes).orderBy(desc(personDocumentTypes.isSystem), asc(personDocumentTypes.name))
    const hr = v.typesAdmin || v.view === 'tenant'
    const manager = v.view !== 'none' || v.manage !== 'none'
    return rows
      .filter(r => hr || (r.type.isActive && (manager ? r.type.visibleToManager : r.type.selfUpload)))
      .map(r => ({ ...r.type, documentsCount: r.documentsCount }))
  })
}

export type TypeWriteError = { ok: false, code: 'not_found' | 'forbidden' | 'code.exists' | 'type_is_system' } | { ok: false, code: 'type_in_use', count: number }

export async function createDocumentType(ctx: Ctx, v: DocViewer, input: DocumentTypeCreateInput): Promise<{ ok: true, type: TypeRow } | TypeWriteError> {
  if (!v.typesAdmin) return { ok: false, code: 'forbidden' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const code = input.code ?? `custom_${randomBytes(4).toString('hex')}`
    const [dup] = await tx.select({ id: personDocumentTypes.id }).from(personDocumentTypes).where(eq(personDocumentTypes.code, code))
    if (dup) return { ok: false, code: 'code.exists' }
    const [row] = await tx.insert(personDocumentTypes).values({
      tenantId: ctx.tenantId,
      code,
      name: input.name,
      isRequired: input.isRequired,
      requiredPositions: input.requiredPositions,
      validityMonths: input.validityMonths,
      remindDays: input.remindDays,
      isFactOnly: input.isFactOnly,
      selfUpload: input.selfUpload,
      visibleToManager: input.visibleToManager,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_document_type.create', entity: 'person_document_types', entityId: row!.id, after: row })
    return { ok: true, type: row! }
  })
}

/**
 * Правка типа. Деактивация используемого типа **разрешена** (§12: «тип уходит из формы
 * добавления, записи остаются, строка-заглушка больше не показывается») — `409 type_in_use`
 * только на удаление (см. `deleteDocumentType`).
 */
export async function updateDocumentType(ctx: Ctx, v: DocViewer, id: string, input: DocumentTypeUpdateInput): Promise<{ ok: true, type: TypeRow } | TypeWriteError> {
  if (!v.typesAdmin) return { ok: false, code: 'forbidden' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (!isUuid(id)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select().from(personDocumentTypes).where(eq(personDocumentTypes.id, id))
    if (!cur) return { ok: false, code: 'not_found' }
    const patch = Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) as Partial<TypeRow>
    const [row] = await tx.update(personDocumentTypes).set({ ...patch, updatedAt: new Date() }).where(eq(personDocumentTypes.id, id)).returning()
    const keys = Object.keys(patch)
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'person_document_type.update',
      entity: 'person_document_types',
      entityId: id,
      before: Object.fromEntries(keys.map(k => [k, cur[k as keyof TypeRow]])),
      after: Object.fromEntries(keys.map(k => [k, row![k as keyof TypeRow]])),
    })
    return { ok: true, type: row! }
  })
}

/** Удаление типа: системный — никогда; используемый — `409 type_in_use` с числом документов. */
export async function deleteDocumentType(ctx: Ctx, v: DocViewer, id: string): Promise<{ ok: true } | TypeWriteError> {
  if (!v.typesAdmin) return { ok: false, code: 'forbidden' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (!isUuid(id)) return { ok: false, code: 'not_found' }
    const [cur] = await tx.select().from(personDocumentTypes).where(eq(personDocumentTypes.id, id))
    if (!cur) return { ok: false, code: 'not_found' }
    if (cur.isSystem) return { ok: false, code: 'type_is_system' }
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(personDocuments).where(eq(personDocuments.typeId, id))
    if ((used?.n ?? 0) > 0) return { ok: false, code: 'type_in_use', count: used!.n }
    await tx.delete(personDocumentTypes).where(eq(personDocumentTypes.id, id))
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'person_document_type.delete', entity: 'person_document_types', entityId: id, before: cur })
    return { ok: true }
  })
}

// ── Ночной скан сроков (`38` §11 `documents.expiry_scan`, §4, §7.8, §8) ─────────────────

/** HR — носители `person.document.manage` на весь тенант (§2: «роль hr — носитель скоупов … в области тенанта»). */
async function documentHr(tx: TenantTx): Promise<string[]> {
  const rows = await tx.execute(sql`
    select distinct ur.user_id from user_roles ur
    join roles r on r.id = ur.role_id
    join users u on u.id = ur.user_id
    where ur.scope_type = 'tenant' and r.scopes @> array['person.document.manage']::text[]
      and (ur.valid_until is null or ur.valid_until > now())
      and u.status = 'active' and not u.is_blocked
      ${EMPLOYEES_ONLY('u')}`) as unknown as { user_id: string }[]
  return rows.map(r => r.user_id)
}

export interface ExpiryScanStats { expiring: number, expired: number, notified: number }

/**
 * `documents.expiry_scan` — ежесуточно 06:00 (§11): переходы `valid → expiring → expired` и
 * уведомления §8 человеку, его руководителю (`resolveManager()`; если тип ему виден) и HR. Напоминание — в день
 * перехода и в дни `remind_days`; после истечения — ежедневно ещё 14 дней (§7.8). Ключ
 * дедупликации — документ, день и адресат: повторный запуск в тот же день второго сообщения
 * не даёт. Уволенным и кандидатам уведомлений нет, а срок документа двигается всё равно.
 */
export async function documentsExpiryScanTenant(tenantId: string, now = new Date()): Promise<ExpiryScanStats> {
  return withTenant(tenantId, null, async (tx) => {
    const today = await tenantToday(tx, tenantId, now)
    const stats: ExpiryScanStats = { expiring: 0, expired: 0, notified: 0 }
    const rows = await tx.execute(sql`
      select d.id, d.user_id, d.status, d.expires_at::text as expires_at, t.name as type_name, t.remind_days,
             t.visible_to_manager, u.full_name, (u.status <> 'archived' and not u.is_blocked) as reachable
      from person_documents d
      join person_document_types t on t.id = d.type_id
      join users u on u.id = d.user_id
      where d.expires_at is not null
        and (d.status in ('valid', 'expiring')
             or (d.status = 'expired' and d.expires_at >= ${today}::date - ${14}::int))
        ${EMPLOYEES_ONLY('u')}`) as unknown as {
      id: string, user_id: string, status: PersonDocumentStatus, expires_at: IsoDate, type_name: string, remind_days: number[],
      visible_to_manager: boolean, full_name: string, reachable: boolean
    }[]
    let hr: string[] | null = null
    for (const d of rows) {
      const next = documentStatusBy(d.expires_at, today, d.remind_days)
      const justBecameExpiring = d.status === 'valid' && next === 'expiring'
      if (next !== d.status) {
        await tx.update(personDocuments).set({ status: next, updatedAt: now }).where(eq(personDocuments.id, d.id))
        await recordAudit(tx, { tenantId, actorId: null, action: 'person_document.status_changed', entity: 'person_documents', entityId: d.id, before: { status: d.status }, after: { status: next, expiresAt: d.expires_at } })
        if (next === 'expiring') stats.expiring++
        if (next === 'expired') stats.expired++
      }
      const due = documentReminderDue(d.expires_at, today, d.remind_days, justBecameExpiring)
      if (!due || !d.reachable) continue

      hr ??= await documentHr(tx)
      // Руководитель — единственным источником истины (`resolveManager()`, П-16.4): дерево,
      // затем точка, затем роль в области; тип, скрытый от руководителя, ему не приходит (§2)
      const manager = d.visible_to_manager ? await managerIdOf(tx, d.user_id) : null
      const recipients = [...new Set([d.user_id, ...(manager ? [manager] : []), ...hr])]
      const code = due === 'expiring' ? 'person_document_expiring' : 'person_document_expired'
      for (const to of recipients) {
        const sent = await enqueueNotification(tx, {
          tenantId,
          userId: to,
          code,
          // Дата — полдень UTC: шаблон форматирует её по локали получателя, и сдвиг пояса не
          // перекинет её на соседний день ни в одном часовом поясе от UTC−11 до UTC+11
          payload: { type: d.type_name, date: `${d.expires_at}T12:00:00.000Z`, days: Math.max(0, daysBetween(today, d.expires_at)), ...(to !== d.user_id ? { person: d.full_name } : {}), personId: d.user_id, documentId: d.id },
          dedupKey: `${code}:${d.id}:${today}:${to}`,
          refType: 'person_document',
          refId: d.id,
        })
        if (sent) stats.notified++
      }
    }
    return stats
  })
}
