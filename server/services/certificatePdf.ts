import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import PDFDocument from 'pdfkit'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { certificates, courses, tenants, users } from '../db/schema'
import { db } from '../db/client'
import { withTenant } from '../utils/withTenant'
import { formatDate } from '../../shared/domain/dateFormat'
import type { Locale } from '../../shared/domain/dateFormat'
import { recipientLocale } from '../utils/formatLocale'
import { defaultDictionary } from './translations'
import { S3_BUCKET, ensureBucket, s3, signedReadUrl } from './media'

/**
 * PDF сертификата (docs/14 §7.5): из шаблона в стиле брендбука, в S3, ссылка подписанная.
 * Рендер без headless-браузера (pdfkit + Nunito) — образ прода без Chromium.
 * При смене шаблона старые PDF не перегенерируются: ключ хранится в certificates.pdf_key.
 * Локаль (докс/28, долг PR-107): `users.locale ?? tenants.locale ?? 'uk'`, той самий порядок,
 * що і в `dispatchNotifications` — надписи беруться з `i18n/locales/<locale>.json` (`cert.pdf.*`),
 * дата — через єдину утиліту форматування.
 */

const FONTS = join(process.cwd(), 'server/assets/fonts')

// Node 23.4: TextDecoder('ascii').decode возвращает Buffer вместо строки — fontkit не распознаёт TTF.
// На проде Node 22 (docker/Dockerfile) — бага нет; для dev/тестов на 23.4 приводим результат к строке.
if (typeof new TextDecoder('ascii').decode(new Uint8Array([65])) !== 'string') {
  const orig = TextDecoder.prototype.decode
  TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
    const r = orig.call(this, input, options) as unknown
    return typeof r === 'string' ? r : Buffer.from(r as Uint8Array).toString('latin1')
  }
}
let fontCache: { regular: Buffer, black: Buffer } | null = null
function fonts() {
  fontCache ??= { regular: readFileSync(join(FONTS, 'Nunito-Regular.ttf')), black: readFileSync(join(FONTS, 'Nunito-Black.ttf')) }
  return fontCache
}

export interface CertData { number: string, fullName: string, courseTitle: string, tenantName: string, issuedAt: Date, validUntil: Date | null, score: string | null, publicUrl: string, locale?: Locale }

/** Чистая функция: данные → PDF-буфер. Токены бренда: bg #f0e7d7, ink #0c0f14, sun #f6d365, teal #3ba99c. */
export function renderCertificatePdf(d: CertData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const locale = d.locale ?? 'uk'
    const dict = defaultDictionary(locale)
    const tr = (key: string) => dict[`cert.pdf.${key}`] ?? key
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `${tr('badge')} ${d.number}`, Author: d.tenantName } })
    const chunks: Buffer[] = []
    doc.on('data', c => chunks.push(c as Buffer))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    const f = fonts()
    doc.registerFont('Nunito', f.regular).registerFont('NunitoBlack', f.black)
    const W = doc.page.width, H = doc.page.height
    const fmt = (x: Date) => formatDate(x, locale, { day: 'numeric', month: 'long', year: 'numeric' })

    doc.rect(0, 0, W, H).fill('#f0e7d7')
    doc.roundedRect(36, 36, W - 72, H - 72, 36).fill('#faf6ec')
    doc.rect(36, 36, 14, H - 72).fill('#f6d365')
    doc.font('NunitoBlack').fontSize(30).fillColor('#0c0f14').text('Lola', 80, 70)
    doc.font('Nunito').fontSize(12).fillColor('#6b6154').text(d.tenantName, 80, 108)
    doc.font('Nunito').fontSize(14).fillColor('#6b6154').text(tr('badge').toUpperCase(), 80, 170, { characterSpacing: 4 })
    doc.font('NunitoBlack').fontSize(34).fillColor('#0c0f14').text(d.fullName, 80, 195, { width: W - 160 })
    doc.font('Nunito').fontSize(16).fillColor('#0c0f14').text(tr('completed'), 80, 250)
    doc.font('NunitoBlack').fontSize(22).fillColor('#0c0f14').text(d.courseTitle, 80, 275, { width: W - 160 })

    const y = 380
    const col = (x: number, label: string, value: string) => {
      doc.font('Nunito').fontSize(10).fillColor('#6b6154').text(label, x, y)
      doc.font('NunitoBlack').fontSize(14).fillColor('#0c0f14').text(value, x, y + 16, { width: 200 })
    }
    col(80, tr('number').toUpperCase(), d.number)
    col(260, tr('issued').toUpperCase(), fmt(d.issuedAt))
    col(440, tr('validUntil').toUpperCase(), d.validUntil ? fmt(d.validUntil) : tr('unlimited'))
    if (d.score) col(640, tr('result').toUpperCase(), `${Number(d.score)}%`)

    doc.roundedRect(80, H - 120, 12, 12, 6).fill('#3ba99c')
    doc.font('Nunito').fontSize(10).fillColor('#6b6154').text(`${tr('verify')}: ${d.publicUrl}`, 100, H - 120)
    doc.end()
  })
}

/** Рендер и загрузка в S3, идемпотентно: если pdf_key уже есть — не трогаем (docs/14 §7.5). */
export async function renderAndStore(tenantId: string, certificateId: string): Promise<{ key: string, created: boolean } | null> {
  const row = await withTenant(tenantId, null, async (tx) => {
    const [c] = await tx.select({ id: certificates.id, number: certificates.number, pdfKey: certificates.pdfKey, issuedAt: certificates.issuedAt, validUntil: certificates.validUntil, score: certificates.score, publicToken: certificates.publicToken, fullName: users.fullName, courseTitle: courses.title, userLocale: users.locale })
      .from(certificates).innerJoin(users, eq(users.id, certificates.userId)).leftJoin(courses, eq(courses.id, certificates.courseId)).where(eq(certificates.id, certificateId))
    return c ?? null
  })
  if (!row) return null
  if (row.pdfKey) return { key: row.pdfKey, created: false }
  const [tenant] = await db.select({ name: tenants.name, locale: tenants.locale }).from(tenants).where(eq(tenants.id, tenantId))
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const locale = recipientLocale(row.userLocale, tenant?.locale)
  const pdf = await renderCertificatePdf({ number: row.number, fullName: row.fullName, courseTitle: row.courseTitle ?? '', tenantName: tenant?.name ?? 'Lola', issuedAt: row.issuedAt, validUntil: row.validUntil, score: row.score, publicUrl: `${base}/c/${row.publicToken}`, locale })
  const key = `t/${tenantId}/certificates/${row.number.replace(/[^A-Za-z0-9-]/g, '')}.pdf`
  await ensureBucket()
  await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: pdf, ContentType: 'application/pdf' }))
  await withTenant(tenantId, null, tx => tx.update(certificates).set({ pdfKey: key, updatedAt: new Date() }).where(eq(certificates.id, certificateId)))
  return { key, created: true }
}

/** Подписанная ссылка на PDF; отозванный сертификат не отдаётся (docs/14 §13.7). */
export async function pdfUrl(ctx: { tenantId: string, actorId: string }, certificateId: string, opts: { manage: boolean }): Promise<{ url: string } | { error: 'not_found' | 'revoked' | 'forbidden' | 'not_ready' }> {
  const [c] = await withTenant(ctx.tenantId, ctx.actorId, tx => tx.select({ userId: certificates.userId, pdfKey: certificates.pdfKey, revokedAt: certificates.revokedAt }).from(certificates).where(eq(certificates.id, certificateId)))
  if (!c) return { error: 'not_found' }
  if (c.userId !== ctx.actorId && !opts.manage) return { error: 'forbidden' }
  if (c.revokedAt) return { error: 'revoked' }
  let key = c.pdfKey
  if (!key) key = (await renderAndStore(ctx.tenantId, certificateId))?.key ?? null
  if (!key) return { error: 'not_ready' }
  return { url: await signedReadUrl(key) }
}
