import { randomUUID } from 'node:crypto'
import PDFDocument from 'pdfkit'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { and, eq, sql } from 'drizzle-orm'
import { candidateSummaries, mediaAssets, tenants } from '../db/schema'
import { db } from '../db/client'
import { withTenant, type TenantTx } from '../utils/withTenant'
import { formatDate, resolveLocale, type Locale } from '../../shared/domain/dateFormat'
import { candidateView, disclaimerLine, type SummaryBody } from '../../shared/domain/candidateSummary'
import { fonts } from './certificatePdf'
import { defaultDictionary } from './translations'
import { S3_BUCKET, ensureBucket, s3, signedReadUrl } from './media'

/**
 * PDF «Підсумку кандидата» (`docs/v2/30-ai-interview.md` §3.5 `media_id`, §7.7, §7.9, §7.14, §11;
 * `44` Р-AI2.9).
 *
 * **PDF — ровно то, что видит кандидат:** включённые рекрутером разделы (`candidateView()`), без ПД
 * третьих лиц, и всегда строка «Документ сформовано автоматично…» — из текста документа, как на
 * странице по ссылке (`30` §13 к. 14). Рендер — pdfkit с Nunito, как у сертификата: образ прода без
 * браузера.
 *
 * **Хранится только отправленная версия.** До отправки документ правят и выключают разделы, и
 * сохранённый файл тут же устаревал бы; отправленный больше не меняется (`409 summary.sent`). При
 * отправке PDF кладётся в S3 строкой `media_assets` (`origin = 'ai_artifact'`, владелец — кандидат,
 * источник — `candidate_summaries`), ссылка — в `candidate_summaries.media_id`; срок — политика
 * хранения `ai_artifact` (12 мес., `34` §7.3). Сбой S3 не роняет отправку: файл досоздаётся при
 * первом скачивании. Рекрутеру до отправки PDF рендерится на лету и нигде не хранится.
 *
 * Обезличивание и отзыв согласия — в корзину с немедленной очисткой вместе с телом документа
 * (`candidateSummaries.ts#redactSummariesTx`, `30` §7.9).
 */

// ── Рендер ─────────────────────────────────────────────────────────────────────────────

export interface SummaryPdfData {
  doc: ReturnType<typeof candidateView>
  lang: Locale
  version: number
  completeness: 'full' | 'partial'
  tenantName: string
  /** Дата документа для шапки — отправки, иначе сборки. */
  date: Date
}

/** Чистая функция: документ → PDF-буфер. Токены бренда — как у сертификата (`certificatePdf.ts`). */
export function renderSummaryPdf(d: SummaryPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dict = defaultDictionary(d.lang)
    const tr = (key: string, params: Record<string, string | number> = {}) =>
      (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
    const fmt = (iso: string | Date) => formatDate(iso, d.lang, { day: 'numeric', month: 'long', year: 'numeric' })
    const pdf = new PDFDocument({ size: 'A4', margin: 56, info: { Title: tr('candidateSummary.title'), Author: d.tenantName } })
    const chunks: Buffer[] = []
    pdf.on('data', c => chunks.push(c as Buffer))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)
    const f = fonts()
    pdf.registerFont('Nunito', f.regular).registerFont('NunitoBlack', f.black)
    const W = pdf.page.width - 112
    const INK = '#0c0f14'
    const MUTED = '#6b6154'

    const text = (s: string, o: { size?: number, bold?: boolean, color?: string, gap?: number } = {}) => {
      pdf.font(o.bold ? 'NunitoBlack' : 'Nunito').fontSize(o.size ?? 11).fillColor(o.color ?? INK).text(s, { width: W })
      if (o.gap) pdf.moveDown(o.gap)
    }
    const heading = (key: string) => {
      pdf.moveDown(0.8)
      text(tr(`candidateSummary.section.${key}`).toUpperCase(), { size: 9, bold: true, color: MUTED, gap: 0.3 })
    }

    pdf.rect(0, 0, pdf.page.width, 8).fill('#f6d365')
    text('Lola', { size: 22, bold: true })
    text(d.tenantName, { size: 10, color: MUTED, gap: 0.8 })
    text(tr('candidateSummary.title'), { size: 20, bold: true })
    text([tr('candidateSummary.version', { n: d.version }), fmt(d.date), ...(d.completeness === 'partial' ? [tr('candidateSummary.partial')] : [])].join(' · '), { size: 10, color: MUTED })

    const doc = d.doc
    if (doc.candidate) {
      heading('candidate')
      text(doc.candidate.fullName, { bold: true, size: 13 })
      text(`${tr('candidateSummary.vacancy')}: ${doc.candidate.vacancyTitle ?? tr('candidateSummary.noVacancy')}`, { color: MUTED })
    }
    if (doc.progress) {
      heading('progress')
      if (!doc.progress.items.length) text(tr('candidateSummary.nothing'), { color: MUTED })
      for (const p of doc.progress.items) {
        const score = p.score !== null ? ` · ${tr('candidateSummary.score', { value: p.score })}` : ''
        text(`• ${p.title} — ${tr(`candidateSummary.kind.${p.kind}`)} · ${tr(`enrollment.${p.status}`)}${score}`)
      }
    }
    if (doc.scores) {
      heading('scores')
      if (!doc.scores.items.length) text(tr('candidateSummary.nothing'), { color: MUTED })
      for (const s of doc.scores.items) {
        text(`• ${tr(`candidate.scoreKind.${s.kind}`)}: ${s.value ?? '—'} · ${fmt(s.at)}${s.aiStub ? ` · ${tr('candidateSummary.stubScore')}` : ''}`)
      }
    }
    if (doc.interview) {
      heading('interview')
      const iv = doc.interview
      text(`${iv.scenarioName}${iv.finishedAt ? ` · ${fmt(iv.finishedAt)}` : ''}`, { color: MUTED })
      if (iv.aiScore !== null) {
        text(tr('candidateSummary.interviewScore', { value: iv.aiScore, confidence: iv.confidenceWord ? tr(`interview.card.confidenceWord.${iv.confidenceWord}`) : '—' }))
      }
      if (iv.needsHuman) text(tr('candidateSummary.needsHuman'))
      if (iv.aiStub) text(tr('interview.card.stub'), { color: MUTED })
      for (const c of iv.criteria) {
        pdf.moveDown(0.3)
        text(`${c.name}: ${c.value ?? '—'} / ${c.scaleMax}${c.humanValue !== null ? ` · ${tr('candidateSummary.human', { value: c.humanValue })}` : ''}`, { bold: true })
        if (c.rationale) text(c.rationale, { color: MUTED, size: 10 })
        if (c.quote) text(`«${c.quote}»`, { size: 10 })
      }
    }
    if (doc.strengthsRisks) {
      heading('strengths_risks')
      const sr = doc.strengthsRisks
      if (sr.status === 'ready') {
        text(tr('candidateSummary.strengths'), { bold: true, size: 10 })
        for (const x of sr.strengths.length ? sr.strengths : [tr('candidateSummary.nothing')]) text(`• ${x}`)
        text(tr('candidateSummary.risks'), { bold: true, size: 10 })
        for (const x of sr.risks.length ? sr.risks : [tr('candidateSummary.nothing')]) text(`• ${x}`)
        if (sr.aiStub) text(tr('interview.card.stub'), { color: MUTED })
      }
      else text(tr('candidateSummary.unavailable'), { color: MUTED })
      text(sr.caveat, { size: 10, color: MUTED })
    }
    if (doc.incomplete && doc.incomplete.items.length) {
      heading('incomplete')
      for (const x of doc.incomplete.items) text(`• ${x.title} · ${tr(`enrollment.${x.status}`)}`)
    }
    if (doc.passport) {
      heading('passport')
      text(tr('candidateSummary.generatedAt', { date: fmt(doc.passport.generatedAt) }), { color: MUTED })
      if (doc.passport.model) text(tr('candidateSummary.model', { model: doc.passport.model, prompt: doc.passport.promptVersion ?? '—' }), { color: MUTED })
    }
    // Несъёмная строка документа (§7.14, §13 к. 14) — всегда последней
    pdf.moveDown(1.2)
    text(disclaimerLine(doc.disclaimer), { size: 10, color: MUTED })
    pdf.end()
  })
}

// ── Хранение ───────────────────────────────────────────────────────────────────────────

type ObjectPut = (key: string, body: Buffer) => Promise<void>
const s3Put: ObjectPut = async (key, body) => {
  await ensureBucket()
  await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: body, ContentType: 'application/pdf' }))
}
let putObject: ObjectPut = s3Put
/** Подмена записи в S3 в тестах (MinIO в локальном прогоне нет). `null` — вернуть настоящую. */
export function setSummaryPdfStore(fn: ObjectPut | null): void {
  putObject = fn ?? s3Put
}

type Row = typeof candidateSummaries.$inferSelect

async function tenantNameOf(tenantId: string): Promise<string> {
  const [t] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId))
  return t?.name ?? 'Lola'
}

/** Данные PDF из строки документа: только то, что видит кандидат. */
export async function pdfDataOf(tenantId: string, r: Row): Promise<SummaryPdfData> {
  return {
    doc: candidateView(r.body as SummaryBody, r.sections as string[]),
    lang: resolveLocale(r.lang),
    version: r.version,
    completeness: r.completeness as 'full' | 'partial',
    tenantName: await tenantNameOf(tenantId),
    date: r.sentAt ?? r.createdAt,
  }
}

async function activeMediaKey(tx: TenantTx, mediaId: string | null): Promise<string | null> {
  if (!mediaId) return null
  const [m] = await tx.select({ key: mediaAssets.key, lifecycle: mediaAssets.lifecycle }).from(mediaAssets).where(eq(mediaAssets.id, mediaId))
  return m && m.lifecycle === 'active' ? m.key : null
}

/**
 * PDF отправленного документа — ключ в S3; нет — рендер, запись, строка `media_assets` и
 * `media_id`. Идемпотентно: второй вызов отдаёт тот же файл. Не отправленный, отозванный или
 * стёртый документ файла не получает (`null`).
 */
export async function ensureSummaryPdf(tenantId: string, summaryId: string): Promise<string | null> {
  const row = await withTenant(tenantId, null, async (tx) => {
    const [r] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, summaryId))
    if (!r || r.state !== 'sent' || r.redactedAt) return null
    return { r, key: await activeMediaKey(tx, r.mediaId) }
  })
  if (!row) return null
  if (row.key) return row.key

  const buf = await renderSummaryPdf(await pdfDataOf(tenantId, row.r))
  const now = new Date()
  const key = `t/${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/summary-${randomUUID()}.pdf`
  await putObject(key, buf)
  return withTenant(tenantId, null, async (tx) => {
    const [cur] = await tx.select().from(candidateSummaries).where(eq(candidateSummaries.id, summaryId)).for('update')
    // Пока рендерили, документ стёрли или отозвали — файл не регистрируем: объект без строки
    // найдёт сверка хранилища (`storage.object_reconcile`)
    if (!cur || cur.state !== 'sent' || cur.redactedAt) return null
    const existing = await activeMediaKey(tx, cur.mediaId)
    if (existing) return existing
    const [m] = await tx.insert(mediaAssets).values({
      tenantId,
      key,
      originalName: `pidsumok-v${cur.version}.pdf`,
      kind: 'file',
      mime: 'application/pdf',
      bytes: buf.length,
      status: 'ready',
      ownerUserId: cur.candidateId,
      origin: 'ai_artifact',
      sourceEntity: 'candidate_summaries',
      sourceId: cur.id,
      isEvidence: false,
    }).returning({ id: mediaAssets.id })
    await tx.update(candidateSummaries).set({ mediaId: m!.id, updatedAt: new Date() }).where(eq(candidateSummaries.id, cur.id))
    return key
  })
}

/** Подписанная ссылка на PDF отправленного документа (кандидату по токену и рекрутеру). */
export async function summaryPdfUrl(tenantId: string, summaryId: string): Promise<string | null> {
  const key = await ensureSummaryPdf(tenantId, summaryId)
  return key ? signedReadUrl(key) : null
}

/**
 * Файлы PDF документов кандидата — в корзину с немедленной очисткой (`30` §7.9): в транзакции
 * обезличивания или отзыва согласия, вместе с телом документа.
 */
export async function discardSummaryPdfsTx(tx: TenantTx, summaryIds: string[], reason: string): Promise<number> {
  if (!summaryIds.length) return 0
  const rows = await tx.execute(sql`
    update media_assets
       set lifecycle = 'pending_delete', deleted_at = now(), delete_reason = ${reason}, purge_after = now(), updated_at = now()
     where origin = 'ai_artifact' and lifecycle in ('active', 'orphaned')
       and source_entity = 'candidate_summaries'
       and source_id in (${sql.join(summaryIds.map(id => sql`${id}::uuid`), sql`, `)})
    returning id`) as unknown as { id: string }[]
  await tx.update(candidateSummaries).set({ mediaId: null })
    .where(and(sql`${candidateSummaries.id} in (${sql.join(summaryIds.map(id => sql`${id}::uuid`), sql`, `)})`, sql`${candidateSummaries.mediaId} is not null`))
  return rows.length
}
