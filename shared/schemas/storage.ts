import { z } from 'zod'
import {
  LIFECYCLE_STAGE_CODES,
  MEDIA_ORIGINS,
  STORAGE_OTHER_KEY,
  STORAGE_RETENTION_ACTIONS,
  STORAGE_RETENTION_ANCHORS,
} from '../enums'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты хранилища (docs/v2/34-storage.md §6, §10; план docs/v2/45 PR-36). Один источник
 * для клиента и сервера (CLAUDE.md п. 7).
 */

/** Слово подтверждения удаления доказательства (§6.1) — то же, что у `DELETE /media/:id`. */
export const STORAGE_CONFIRM_PHRASE = 'ВИДАЛИТИ'

/** Девять ключей разбивки «За етапом» (решение docs/v2/44 В-10): восемь кодов этапов + `other`. */
export const STORAGE_STAGE_KEYS = [...LIFECYCLE_STAGE_CODES, STORAGE_OTHER_KEY] as const

/** `GET /storage/summary?groupBy=origin|stage` — «За походженням» по умолчанию (§5.1). */
export const storageSummaryQuerySchema = z.object({
  groupBy: z.enum(['origin', 'stage']).default('origin'),
})

const csv = <T extends [string, ...string[]]>(values: T) => z.preprocess(
  v => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
  z.array(z.enum(values)).max(values.length),
)

/**
 * Фильтры реестра (§5.1): «Походження» (несколько), «Етап», «Категорія», «Трек»,
 * «Співробітник», период по дате загрузки, «Статус», «Тільки докази». Курсор — ключевой
 * (`KEYSETS.storageFiles`, docs/04-api.md §4.1), по 50 строк (лимит 100, §10).
 */
export const storageFilesQuerySchema = z.object({
  origin: csv(MEDIA_ORIGINS as unknown as [string, ...string[]]).optional(),
  stage: z.enum(STORAGE_STAGE_KEYS as unknown as [string, ...string[]]).optional(),
  categoryId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['active', 'orphaned', 'trash', 'failed', 'purged']).default('active'),
  evidenceOnly: z.preprocess(v => v === true || v === 'true' || v === '1', z.boolean()).default(false),
  cursor: keysetCursorSchema(KEYSETS.storageFiles).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type StorageFilesQuery = z.infer<typeof storageFilesQuerySchema>

/** Снимок фильтра экрана в заявке «по фильтру» — те же поля, без курсора и страницы. */
export const storageFilterSnapshotSchema = storageFilesQuerySchema.omit({ cursor: true, limit: true })

/**
 * `POST /storage/deletions` (§6.1, §10): массовое удаление — только заявкой (решение В-17).
 * Выделение на экране (`selection`, до 5000 файлов) или снимок фильтра (`filter`).
 */
export const storageDeletionCreateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('selection'), mediaIds: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ mode: z.literal('filter'), filter: storageFilterSnapshotSchema }),
])
export type StorageDeletionCreate = z.infer<typeof storageDeletionCreateSchema>

/**
 * `POST /storage/deletions/:id/confirm` (§6.1): чекбокс «Розумію, що файли можна відновити
 * протягом 30 днів» — всегда; причина 10–500 символов и слово «ВИДАЛИТИ» — когда среди файлов
 * есть доказательства. Сверка слова и причины — на сервере (он знает `evidenceCount`).
 */
export const storageDeletionConfirmSchema = z.object({
  acknowledged: z.literal(true),
  reason: z.string().trim().max(500).optional(),
  confirmPhrase: z.string().max(64).optional(),
})
export type StorageDeletionConfirm = z.infer<typeof storageDeletionConfirmSchema>

/** Одна политика хранения в форме §6.2. `acknowledgeEvidence` — чекбокс при `keepEvidence=false`. */
export const retentionPolicyInputSchema = z.object({
  origin: z.enum(MEDIA_ORIGINS),
  enabled: z.boolean(),
  keepMonths: z.number().int().min(1).max(120).nullable(),
  anchor: z.enum(STORAGE_RETENTION_ANCHORS),
  action: z.enum(STORAGE_RETENTION_ACTIONS),
  keepEvidence: z.boolean(),
  warnDaysBefore: z.number().int().min(0).max(90),
  maxBatchPerRun: z.number().int().min(1).max(5000),
  trashDays: z.number().int().min(1).max(365),
  acknowledgeEvidence: z.boolean().optional(),
})
export type RetentionPolicyInput = z.infer<typeof retentionPolicyInputSchema>

/**
 * `PUT /storage/retention-policies` (§10). `dryRunConfirmed` — администратор видел сухой прогон
 * и подтвердил объём: без него первое включение удаляющей политики не сохраняется (§7.3).
 */
export const retentionPoliciesSaveSchema = z.object({
  policies: z.array(retentionPolicyInputSchema).min(1).max(MEDIA_ORIGINS.length),
  dryRunConfirmed: z.boolean().optional(),
})
export type RetentionPoliciesSave = z.infer<typeof retentionPoliciesSaveSchema>

/** `POST /storage/retention-policies/dry-run` — прогон черновика политики, не сохранённой ещё. */
export const retentionDryRunSchema = retentionPolicyInputSchema.pick({
  origin: true, keepMonths: true, anchor: true, action: true, keepEvidence: true,
})
export type RetentionDryRun = z.infer<typeof retentionDryRunSchema>
