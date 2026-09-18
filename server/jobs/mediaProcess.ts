import { spawnSync } from 'node:child_process'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { mediaAssets } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { S3_BUCKET, s3 } from '../services/media'

export interface MediaProcessJob {
  tenantId: string
  mediaId: string
}

const VARIANT_WIDTHS = [320, 768, 1600] as const

let ffmpegChecked: boolean | undefined
function hasFfmpeg(): boolean {
  if (ffmpegChecked === undefined) {
    ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  }
  return ffmpegChecked
}

/**
 * Обработка медиа (docs/06 §6.2): изображения → webp 320/768/1600 + размеры;
 * видео — постер и перекодирование при наличии ffmpeg, иначе файл отдаётся как есть
 * (dev/CI без ffmpeg; на проде ffmpeg обязателен — docs/26 §26.4, воркер).
 * Идемпотентна: повторный запуск для ready ничего не делает.
 */
export async function processMedia(job: MediaProcessJob): Promise<void> {
  const media = await withTenant(job.tenantId, null, async (tx) => {
    const [row] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, job.mediaId))
    return row ?? null
  })
  if (!media || media.status === 'ready') return

  try {
    if (media.kind === 'image') {
      const obj = await s3().send(new GetObjectCommand({ Bucket: S3_BUCKET(), Key: media.key }))
      const buffer = Buffer.from(await obj.Body!.transformToByteArray())

      const meta = await sharp(buffer).metadata()
      const variants: Record<string, string> = {}
      for (const width of VARIANT_WIDTHS) {
        const resized = await sharp(buffer)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer()
        const variantKey = media.key.replace(/\.[a-z0-9]+$/i, `.${width}.webp`)
        await s3().send(new PutObjectCommand({
          Bucket: S3_BUCKET(),
          Key: variantKey,
          Body: resized,
          ContentType: 'image/webp',
        }))
        variants[String(width)] = variantKey
      }

      await withTenant(job.tenantId, null, async (tx) => {
        await tx.update(mediaAssets).set({
          status: 'ready',
          width: meta.width ?? null,
          height: meta.height ?? null,
          variants,
          updatedAt: new Date(),
        }).where(eq(mediaAssets.id, job.mediaId))
      })
      return
    }

    if (media.kind === 'video' && hasFfmpeg()) {
      // Полное перекодирование появится с выделенным воркером (docs/26);
      // здесь — постер первой секунды, сам файл отдаётся как загружен.
      const url = await import('../services/media').then(m => m.signedReadUrl(media.key))
      const poster = spawnSync('ffmpeg', [
        '-ss', '1', '-i', url, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], { maxBuffer: 20 * 1024 * 1024 })

      let posterKey: string | null = null
      if (poster.status === 0 && poster.stdout.length > 0) {
        posterKey = media.key.replace(/\.[a-z0-9]+$/i, '.poster.jpg')
        await s3().send(new PutObjectCommand({
          Bucket: S3_BUCKET(),
          Key: posterKey,
          Body: poster.stdout,
          ContentType: 'image/jpeg',
        }))
      }

      await withTenant(job.tenantId, null, async (tx) => {
        await tx.update(mediaAssets).set({
          status: 'ready',
          posterKey,
          updatedAt: new Date(),
        }).where(eq(mediaAssets.id, job.mediaId))
      })
      return
    }

    // Видео без ffmpeg, аудио, документы — принимаем как есть
    await withTenant(job.tenantId, null, async (tx) => {
      await tx.update(mediaAssets).set({ status: 'ready', updatedAt: new Date() })
        .where(eq(mediaAssets.id, job.mediaId))
    })
  }
  catch (err) {
    await withTenant(job.tenantId, null, async (tx) => {
      await tx.update(mediaAssets).set({
        status: 'failed',
        error: String(err).slice(0, 500),
        updatedAt: new Date(),
      }).where(eq(mediaAssets.id, job.mediaId))
    })
    throw err
  }
}
