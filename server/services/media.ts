import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { mediaAssets } from '../db/schema'
import { withTenant } from '../utils/withTenant'

/**
 * Медиа (docs/11 §3.4, docs/06 §6.2): presigned PUT в S3, ключ — uuid
 * (имя файла на ключ не влияет), подписанные ссылки на чтение 10 минут.
 */

const ALLOWED: Record<string, { kind: 'image' | 'video' | 'audio' | 'file', maxMb: number }> = {
  'image/jpeg': { kind: 'image', maxMb: 15 },
  'image/png': { kind: 'image', maxMb: 15 },
  'image/gif': { kind: 'image', maxMb: 15 },
  'image/webp': { kind: 'image', maxMb: 15 },
  'video/mp4': { kind: 'video', maxMb: 500 },
  'video/quicktime': { kind: 'video', maxMb: 500 },
  'video/webm': { kind: 'video', maxMb: 500 },
  'audio/mpeg': { kind: 'audio', maxMb: 50 },
  'audio/mp4': { kind: 'audio', maxMb: 50 },
  'application/pdf': { kind: 'file', maxMb: 50 },
  'text/csv': { kind: 'file', maxMb: 50 },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', maxMb: 50 },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', maxMb: 50 },
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
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

interface Ctx { tenantId: string, actorId: string }

export type UploadUrlResult
  = | { ok: true, mediaId: string, uploadUrl: string, key: string }
    | { ok: false, code: 'mime_not_allowed' | 'too_big', message: string }

export async function createUploadUrl(ctx: Ctx, input: {
  filename: string
  mime: string
  bytes: number
}): Promise<UploadUrlResult> {
  const rule = ALLOWED[input.mime]
  if (!rule) return { ok: false, code: 'mime_not_allowed', message: 'Формат не підтримується' }
  if (input.bytes > rule.maxMb * 1024 * 1024) {
    return { ok: false, code: 'too_big', message: `Файл більший за ${rule.maxMb} МБ` }
  }

  const now = new Date()
  const key = `t/${ctx.tenantId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXT[input.mime]}`

  const mediaId = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.insert(mediaAssets).values({
      tenantId: ctx.tenantId,
      key,
      originalName: input.filename,
      kind: rule.kind,
      mime: input.mime,
      bytes: input.bytes,
      status: 'uploading',
      uploadedBy: ctx.actorId,
    }).returning({ id: mediaAssets.id })
    return row!.id
  })

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

/** Подписанная ссылка на чтение, 10 минут (docs/06 §6.2). */
export async function signedReadUrl(key: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: S3_BUCKET(),
    Key: key,
  }), { expiresIn: 600 })
}
