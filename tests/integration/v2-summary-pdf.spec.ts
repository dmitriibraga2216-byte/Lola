import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * PDF «Підсумку кандидата» (`docs/v2/30` §3.5 `media_id`, §7.7, §7.9, §7.14; `44` Р-AI2.9),
 * часть 2 задачи ai-tails-2. Запись в S3 подменена (`setSummaryPdfStore`): MinIO в локальном
 * прогоне нет, а проверяется наше — что PDF это документ кандидата, что хранится только
 * отправленная версия, одна строка `media_assets` и что обезличивание отправляет файл в корзину.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { buildSummaryFor, sendSummary, patchSummary, recruiterSummaryPdf, publicSummaryPdf, redactSummariesTx } = await import('../../server/services/candidateSummaries')
const { renderSummaryPdf, setSummaryPdfStore, ensureSummaryPdf } = await import('../../server/services/summaryPdf')
const { viewerOf } = await import('../../server/services/candidates')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const MARK = 'SPDF'
let tenantId: string
let adminId: string
let recruiter: ReturnType<typeof viewerOf>
const cand: string[] = []
const stored: { key: string, body: Buffer }[] = []
let seq = 0

async function candidateWithScore(): Promise<string> {
  seq++
  const [status] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
  const [row] = await admin`
    insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', candidate_state_at: new Date(),
      candidate_status_id: status!.id, full_name: `${MARK} Кандидатка ${seq}`, phone: `+38067996${String(seq).padStart(4, '0')}`,
      email: `spdf-${seq}-${Date.now()}@example.test`, status: 'active', source: 'manual', recruiter_id: adminId, comm_language: 'uk',
      consent_given_at: new Date(), consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
    })} returning id`
  const id = row!.id as string
  cand.push(id)
  await admin`insert into candidate_scores (tenant_id, candidate_id, kind, value_num, author_id) values (${tenantId}, ${id}, 'recruiter', 72, ${adminId})`
  return id
}

/** Текст PDF без распаковки потоков не читается — проверяем сигнатуру и метаданные документа. */
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-'

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiter = viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view', 'summary.view', 'summary.edit', 'summary.send'], scopeType: 'tenant', scopeId: null }] })
  await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
  setSummaryPdfStore(async (key, body) => { stored.push({ key, body }) })
})

afterEach(() => { stored.length = 0 })

afterAll(async () => {
  setSummaryPdfStore(null)
  if (cand.length) {
    const ids = admin(cand)
    await admin`delete from candidate_summaries where candidate_id in ${ids}`
    await admin`delete from media_assets where owner_user_id in ${ids}`
    await admin`delete from ai_calls where subject_user_id in ${ids}`
    await admin`delete from notifications where user_id in ${ids}`
    await admin`delete from candidate_scores where candidate_id in ${ids}`
    await admin`delete from users where id in ${ids}`
  }
  await admin.end()
})

describe('PDF Підсумку (30 §3.5, §7.9; 44 Р-AI2.9)', () => {
  it('рендер: PDF документа кандидата с кириллицей, без исключений на пустых разделах', async () => {
    const pdf = await renderSummaryPdf({
      doc: {
        candidate: { fullName: 'Олена Іваненко', vacancyTitle: null },
        progress: { items: [] },
        disclaimer: { text: 'Документ сформовано автоматично на основі відповідей кандидата.', humanCheckedText: 'Оцінки програми перевірено людиною: ні.', humanChecked: false },
      } as never,
      lang: 'uk', version: 1, completeness: 'partial', tenantName: 'Каппі', date: new Date(),
    })
    expect(isPdf(pdf)).toBe(true)
    expect(pdf.length).toBeGreaterThan(1000)
  })

  it('до отправки — рекрутеру на лету, ничего не хранится; отправка кладёт одну копию и media_id', async () => {
    const userId = await candidateWithScore()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    if (!built.ok) throw new Error(JSON.stringify(built))
    const draft = await recruiterSummaryPdf(recruiter, built.summary.id)
    expect(draft.ok && isPdf(draft.pdf)).toBe(true)
    expect(stored).toHaveLength(0)
    expect(await ensureSummaryPdf(tenantId, built.summary.id)).toBeNull() // не отправлен — не хранится

    const sent = await sendSummary(recruiter, built.summary.id, 'link')
    if (!sent.ok) throw new Error(JSON.stringify(sent))
    expect(stored).toHaveLength(1)
    expect(isPdf(stored[0]!.body)).toBe(true)
    const [row] = await admin`select s.media_id, m.origin, m.owner_user_id, m.source_entity, m.source_id, m.mime, m.lifecycle, m.key
      from candidate_summaries s join media_assets m on m.id = s.media_id where s.id = ${built.summary.id}`
    expect(row).toMatchObject({ origin: 'ai_artifact', owner_user_id: userId, source_entity: 'candidate_summaries', source_id: built.summary.id, mime: 'application/pdf', lifecycle: 'active', key: stored[0]!.key })

    // Повтор — тот же файл, без второй записи; ссылка кандидату — подписанная на него
    expect(await ensureSummaryPdf(tenantId, built.summary.id)).toBe(row!.key)
    const pub = await publicSummaryPdf(sent.shareToken, { ip: '10.9.9.31' })
    expect(pub.ok && pub.url).toContain(encodeURIComponent(row!.key as string).replace(/%2F/g, '/'))
    expect(stored).toHaveLength(1)
    // Отправленный документ не правится — PDF не устаревает
    expect(await patchSummary(recruiter, built.summary.id, { risks: ['Інше'] }, true)).toEqual({ ok: false, code: 'sent' })
  })

  it('S3 недоступен при отправке — отправка состоялась, файл досоздаётся при скачивании', async () => {
    const userId = await candidateWithScore()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    if (!built.ok) throw new Error('build')
    setSummaryPdfStore(async () => { throw new Error('S3 down') })
    const sent = await sendSummary(recruiter, built.summary.id, 'link')
    expect(sent.ok).toBe(true)
    expect((await admin`select media_id from candidate_summaries where id = ${built.summary.id}`)[0]!.media_id).toBeNull()
    if (!sent.ok) return
    expect(await publicSummaryPdf(sent.shareToken, { ip: '10.9.9.32' })).toEqual({ ok: false, code: 'unavailable' })
    setSummaryPdfStore(async (key, body) => { stored.push({ key, body }) })
    expect((await publicSummaryPdf(sent.shareToken, { ip: '10.9.9.32' })).ok).toBe(true)
    expect((await admin`select media_id from candidate_summaries where id = ${built.summary.id}`)[0]!.media_id).not.toBeNull()
  })

  it('обезличивание: PDF в корзину с немедленной очисткой, media_id обнулён, ссылки нет, рекрутеру — redacted', async () => {
    const userId = await candidateWithScore()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    if (!built.ok) throw new Error('build')
    const sent = await sendSummary(recruiter, built.summary.id, 'link')
    if (!sent.ok) throw new Error('send')
    const mediaId = (await admin`select media_id from candidate_summaries where id = ${built.summary.id}`)[0]!.media_id as string
    await withTenant(tenantId, null, tx => redactSummariesTx(tx, tenantId, userId, 'anonymized'))
    const [m] = await admin`select lifecycle, delete_reason, purge_after <= now() as due from media_assets where id = ${mediaId}`
    expect(m).toMatchObject({ lifecycle: 'pending_delete', delete_reason: 'anonymized', due: true })
    expect((await admin`select media_id from candidate_summaries where id = ${built.summary.id}`)[0]!.media_id).toBeNull()
    expect(await publicSummaryPdf(sent.shareToken, { ip: '10.9.9.33' })).toEqual({ ok: false, code: 'revoked' })
    expect(await recruiterSummaryPdf(recruiter, built.summary.id)).toEqual({ ok: false, code: 'redacted' })
    const [audit] = await admin`select after from audit_log where action = 'summary.redacted' and entity_id = ${userId} order by created_at desc limit 1`
    expect(audit!.after).toMatchObject({ pdfs: 1 })
  })

  it('чужой или невидимый — 404', async () => {
    const mentor = { ...recruiter, reviewOnly: true }
    const userId = await candidateWithScore()
    const built = await buildSummaryFor(tenantId, adminId, userId)
    if (!built.ok) throw new Error('build')
    expect(await recruiterSummaryPdf(mentor, built.summary.id)).toEqual({ ok: false, code: 'not_found' })
    expect(await recruiterSummaryPdf(recruiter, '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, code: 'not_found' })
  })
})
