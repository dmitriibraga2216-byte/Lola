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
      // Постер первой секунды + перекодирование в H.264 720p mp4 с faststart (docs/11 §3.6, docs/06):
      // оригинал остаётся, плеер берёт вариант «720», если он есть.
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

      const variants: Record<string, string> = { ...(media.variants as Record<string, string>) }
      if (process.env.VIDEO_TRANSCODE !== '0') {
        const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const dir = mkdtempSync(join(tmpdir(), 'lola-video-'))
        try {
          const out = join(dir, 'out.mp4')
          const enc = spawnSync('ffmpeg', [
            '-y', '-i', url, '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
          ], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60_000 })
          if (enc.status === 0) {
            const key720 = media.key.replace(/\.[a-z0-9]+$/i, '.720.mp4')
            await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key720, Body: readFileSync(out), ContentType: 'video/mp4' }))
            variants['720'] = key720
          }
          else {
            console.warn('[media.process] transcode failed:', String(enc.stderr).slice(-400))
          }
        }
        finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }

      await withTenant(job.tenantId, null, async (tx) => {
        await tx.update(mediaAssets).set({
          status: 'ready',
          posterKey,
          variants,
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
