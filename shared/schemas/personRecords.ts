import { z } from 'zod'
import { PERSON_DOCUMENT_LIMITS, PERSON_NOTE_CATEGORIES, PERSON_NOTE_LIMITS, PERSON_NOTE_VISIBILITIES } from '../enums'
import { normalizeNoteBody } from '../domain/personRecords'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты заметок и документов человека (docs/v2/38-people-extensions.md §6.1, §6.2, §10).
 * Один источник для формы карточки и сервера (CLAUDE.md п. 7).
 */

// ── Заметки (`38` §6.1) ─────────────────────────────────────────────────────────────────

/** Текст заметки: 3–2000 знаков после обрезки пробелов; иначе `422 note_body_invalid`. */
export const noteBodySchema = z.string()
  .transform(normalizeNoteBody)
  .pipe(z.string().min(PERSON_NOTE_LIMITS.bodyMin, 'Нотатка має містити від 3 до 2000 символів').max(PERSON_NOTE_LIMITS.bodyMax, 'Нотатка має містити від 3 до 2000 символів'))

export const noteCreateSchema = z.object({
  body: noteBodySchema,
  category: z.enum(PERSON_NOTE_CATEGORIES).default('general'),
  visibility: z.enum(PERSON_NOTE_VISIBILITIES).default('manager'),
  isPinned: z.boolean().default(false),
  /** «Все одно зберегти» после подтверждения скрина (§6.1): ставит `flagged_at`. */
  confirmSensitive: z.boolean().default(false),
})
export type NoteCreateInput = z.infer<typeof noteCreateSchema>

export const noteUpdateSchema = z.object({
  body: noteBodySchema.optional(),
  category: z.enum(PERSON_NOTE_CATEGORIES).optional(),
  visibility: z.enum(PERSON_NOTE_VISIBILITIES).optional(),
  isPinned: z.boolean().optional(),
  confirmSensitive: z.boolean().default(false),
}).refine(v => v.body !== undefined || v.category !== undefined || v.visibility !== undefined || v.isPinned !== undefined, 'Нічого не змінено')
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>

/**
 * Страница ленты заметок (docs/04 §4.1 «Пагинация»): ключевой курсор сервера, `limit` ≤ 100.
 * Каждая страница — отдельное чтение и отдельная запись `person_note.read` со своими `note_ids`.
 */
export const noteListQuerySchema = z.object({
  cursor: keysetCursorSchema(KEYSETS.personNotes).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type NoteListQuery = z.infer<typeof noteListQuerySchema>

/** Удаление чужой заметки администратором — только с причиной (§7.5: «удаление — его решение с причиной»). */
export const noteDeleteSchema = z.object({
  reason: z.string().trim().min(PERSON_DOCUMENT_LIMITS.reasonMin).max(PERSON_DOCUMENT_LIMITS.reasonMax).optional(),
})

// ── Документы (`38` §6.2) ───────────────────────────────────────────────────────────────

const isoDate = z.string().date('Некоректна дата')

export const documentCreateSchema = z.object({
  typeId: z.string().uuid(),
  /** Файл из `POST /media/upload-url` с `origin='person_document'`; у типа «лише факт» — запрещён. */
  mediaId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(PERSON_DOCUMENT_LIMITS.titleMax).nullable().optional(),
  /** Полный номер приходит только сюда и не хранится: остаются последние 4 знака (§7.7). */
  number: z.string().trim().max(PERSON_DOCUMENT_LIMITS.numberMax, 'Номер задовгий').nullable().optional(),
  issuedAt: isoDate,
  expiresAt: isoDate.nullable().optional(),
  note: z.string().trim().max(PERSON_DOCUMENT_LIMITS.noteMax).nullable().optional(),
})
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>

/**
 * Правка документа (§10): срок, отмена, примечание. Отмена (`status='revoked'`) необратима
 * и требует причины (§4); `valid`/`expiring`/`expired` руками не ставятся — их двигает срок.
 */
export const documentUpdateSchema = z.object({
  expiresAt: isoDate.nullable().optional(),
  status: z.literal('revoked').optional(),
  reason: z.string().trim().min(PERSON_DOCUMENT_LIMITS.reasonMin).max(PERSON_DOCUMENT_LIMITS.reasonMax).optional(),
  note: z.string().trim().max(PERSON_DOCUMENT_LIMITS.noteMax).nullable().optional(),
}).refine(v => v.expiresAt !== undefined || v.status !== undefined || v.note !== undefined, 'Нічого не змінено')
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>

// ── Справочник типов (`38` §3.5, CRUD `/person-document-types`) ─────────────────────────

/** Дни напоминаний: 0–365, без повторов, по убыванию — наибольшее и есть окно `expiring` (§4). */
const remindDaysSchema = z.array(z.number().int().min(0).max(365)).min(1).max(5)
  .transform(xs => [...new Set(xs)].sort((a, b) => b - a))

export const documentTypeCreateSchema = z.object({
  /** Необязателен: без него сервер выдаёт свой `custom_…` — код нужен системе, а не человеку. */
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,49}$/, 'Латиниця, цифри та «_»').optional(),
  name: z.string().trim().min(2).max(120),
  isRequired: z.boolean().default(false),
  requiredPositions: z.array(z.string().uuid()).max(200).default([]),
  validityMonths: z.number().int().min(1).max(600).nullable().default(null),
  remindDays: remindDaysSchema.default([30, 7, 0]),
  isFactOnly: z.boolean().default(false),
  selfUpload: z.boolean().default(false),
  visibleToManager: z.boolean().default(true),
})
export type DocumentTypeCreateInput = z.infer<typeof documentTypeCreateSchema>

export const documentTypeUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  isRequired: z.boolean().optional(),
  requiredPositions: z.array(z.string().uuid()).max(200).optional(),
  validityMonths: z.number().int().min(1).max(600).nullable().optional(),
  remindDays: remindDaysSchema.optional(),
  isFactOnly: z.boolean().optional(),
  selfUpload: z.boolean().optional(),
  visibleToManager: z.boolean().optional(),
  isActive: z.boolean().optional(),
})
export type DocumentTypeUpdateInput = z.infer<typeof documentTypeUpdateSchema>
