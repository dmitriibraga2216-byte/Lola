import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { mediaAssets, resources } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { ContentBlock } from '../../shared/schemas/content'
import { GIB, effectiveLimits } from './tenantLimits'

/**
 * Медиа (docs/11 §3.4, Г-11.4, docs/04 §4.15): presigned PUT в S3, ключ — uuid
 * (имя файла на ключ не влияет), подписанные ссылки на чтение 10 минут.
 * Лимиты: изображение ≤ 10 МБ, документ ≤ 50 МБ, аудио ≤ 100 МБ, видео ≤ 500 МБ,
 * на ресурс суммарно ≤ 1 ГБ. Отказ — до начала передачи, с понятным текстом.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

export const MEDIA_LIMITS_MB: Record<MediaKind, number> = { image: 10, file: 50, audio: 100, video: 500 }
export const RESOURCE_TOTAL_LIMIT_MB = 1024

const KIND_LABEL: Record<MediaKind, string> = { image: 'зображення', file: 'документа', audio: 'аудіо', video: 'відео' }

/** Allowlist форматов (docs/11 §3.4): jpg/jpeg/png/gif/webp/svg · mp4/mov/webm · mp3/m4a · pdf/docx/xlsx/pptx/csv/txt. */
const ALLOWED: Record<string, { kind: MediaKind, ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/svg+xml': { kind: 'image', ext: 'svg' }, // очищается при обработке (jobs/mediaProcess → svgSanitize), оригинал перезаписывается
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'audio/mpeg': { kind: 'audio', ext: 'mp3' },
  'audio/mp4': { kind: 'audio', ext: 'm4a' },
  'application/pdf': { kind: 'file', ext: 'pdf' },
  'text/csv': { kind: 'file', ext: 'csv' },
  'text/plain': { kind: 'file', ext: 'txt' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', ext: 'xlsx' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', ext: 'docx' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'file', ext: 'pptx' },
}

export type LimitCheck = { ok: true, kind: MediaKind } | { ok: false, code: 'mime_not_allowed' | 'too_big' | 'resource_too_big', message: string }

/** Проверка лимитов без обращения к хранилищу — чистая функция, чтобы отказ был до начала передачи. */
export function checkFileLimits(mime: string, bytes: number, resourceBytes = 0): LimitCheck {
  const rule = ALLOWED[mime]
  if (!rule) return { ok: false, code: 'mime_not_allowed', message: 'Формат не підтримується' }
  const maxMb = MEDIA_LIMITS_MB[rule.kind]
  if (bytes > maxMb * 1024 * 1024) {
    return { ok: false, code: 'too_big', message: `Файл завеликий. Максимум для ${KIND_LABEL[rule.kind]} — ${maxMb} МБ` }
  }
  if (resourceBytes + bytes > RESOURCE_TOTAL_LIMIT_MB * 1024 * 1024) {
    return { ok: false, code: 'resource_too_big', message: `Файли ресурсу разом не можуть перевищувати ${RESOURCE_TOTAL_LIMIT_MB / 1024} ГБ` }
  }
  return { ok: true, kind: rule.kind }
}

let s3Client: S3Client | undefined

export function s3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
      forcePathStyle: true, // MinIO
    })
  }
  return s3Client
}

export const S3_BUCKET = () => process.env.S3_BUCKET || 'lola-media'

let bucketReady: Promise<void> | undefined
/** Бакет создаётся при первом обращении (dev/CI с чистым MinIO); на проде обычно уже есть. */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    try { await s3().send(new HeadBucketCommand({ Bucket: S3_BUCKET() })) }
    catch {
      try { await s3().send(new CreateBucketCommand({ Bucket: S3_BUCKET() })) }
      catch (e) { bucketReady = undefined; throw e }
    }
  })()
  return bucketReady
}

interface Ctx { tenantId: string, actorId: string }

export type UploadUrlResult
  = | { ok: true, mediaId: string, uploadUrl: string, key: string }
    | { ok: false, code: 'mime_not_allowed' | 'too_big' | 'resource_too_big' | 'storage_limit', message: string }

/** Скільки байт уже займають файли тенанта (докс/33 D-054, docs/25 §10): жорсткий лімит перевіряється по поточному значенню, не по нічному знімку `tenant_usage`. */
export async function tenantStorageBytes(ctx: Ctx): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`select coalesce(sum(bytes), 0)::bigint as bytes from media_assets where deleted_at is null`) as unknown as { bytes: string }[]
    return Number(r?.bytes ?? 0)
  })
}

/** Сколько байт уже занимают файлы ресурса (основной файл + медиа в блоках) — для лимита «на ресурс ≤ 1 ГБ». */
export async function resourceBytes(ctx: Ctx, resourceId: string): Promise<number> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.select({ mediaId: resources.mediaId, body: resources.body }).from(resources).where(eq(resources.id, resourceId))
    if (!r) return 0
    const ids = [...new Set([...(r.mediaId ? [r.mediaId] : []), ...(r.body as ContentBlock[]).flatMap(b => ('mediaId' in b ? [b.mediaId] : []))])]
    if (!ids.length) return 0
    const rows = await tx.select({ bytes: mediaAssets.bytes }).from(mediaAssets).where(and(inArray(mediaAssets.id, ids), isNull(mediaAssets.deletedAt)))
    return rows.reduce((sum, m) => sum + m.bytes, 0)
  })
}

export async function createUploadUrl(ctx: Ctx, input: {
  filename: string
  mime: string
  bytes: number
  resourceId?: string
}): Promise<UploadUrlResult> {
  const used = input.resourceId ? await resourceBytes(ctx, input.resourceId) : 0
  const check = checkFileLimits(input.mime, input.bytes, used)
  if (!check.ok) return check

  // Жорсткий ліміт диска тенанта (docs/25 §10, docs/24 §4.4; докс/33 D-054): перевіряється в момент
  // операції по поточному об'єму, а не по нічному знімку `tenant_usage`. Навчання не зупиняється —
  // блокується лише нове завантаження.
  // Лимит оси `storage_bytes` — в байтах и с доплатами (docs/v2/35 §7.1, §7.3, docs/v2/44 В-5):
  // «+100 ГБ» опцией видна здесь так же, как в баннере и в расчёте счёта — функция одна.
  const limitBytes = (await effectiveLimits(ctx.tenantId)).axes.storage_bytes
  if (limitBytes != null) {
    const used2 = await tenantStorageBytes(ctx)
    if (used2 + input.bytes > limitBytes) {
      return { ok: false, code: 'storage_limit', message: `Ліміт дискового простору (${(limitBytes / GIB).toFixed(0)} ГБ) вичерпано. Зверніться до адміністратора` }
    }
  }

  const now = new Date()
  const key = `t/${ctx.tenantId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ALLOWED[input.mime]!.ext}`

  const mediaId = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.insert(mediaAssets).values({
      tenantId: ctx.tenantId,
      key,
      originalName: input.filename,
      kind: check.kind,
      mime: input.mime,
      bytes: input.bytes,
      status: 'uploading',
      uploadedBy: ctx.actorId,
    }).returning({ id: mediaAssets.id })
    return row!.id
  })

  await ensureBucket()
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({
    Bucket: S3_BUCKET(),
    Key: key,
    ContentType: input.mime,
  }), { expiresIn: 600 })

  return { ok: true, mediaId, uploadUrl, key }
}

/** Подтверждение загрузки: файл в хранилище, ставим обработку. */
export async function completeUpload(ctx: Ctx, mediaId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.update(mediaAssets)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(mediaAssets.id, mediaId))
      .returning()
    return row ?? null
  })
}

export async function getMedia(ctx: Ctx, mediaId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))
    return row ?? null
  })
}

/**
 * Подписанная ссылка на чтение, 10 минут (docs/06 §6.2). SVG (D-011) отдаётся как вложение
 * с явным типом: файл уже очищен при обработке, а `attachment` не даёт открыть его как страницу
 * по прямой ссылке; в `<img src>` вложение показывается как обычно.
 */
export async function signedReadUrl(key: string): Promise<string> {
  const svg = /\.svg$/i.test(key)
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: S3_BUCKET(),
    Key: key,
    ...(svg ? { ResponseContentType: 'image/svg+xml', ResponseContentDisposition: 'attachment' } : {}),
  }), { expiresIn: 600 })
}
