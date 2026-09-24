import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Документы человека (docs/v2/38-people-extensions.md §3.5, §4, §6.2, §7.7, §7.8, §8; PR-32).
 *
 * Критерии приёмки §13: п. 7 — тип `medical_book` с `is_fact_only=true`, `POST` с `mediaId` →
 * `document_file_not_allowed`, запись не создана (HTTP-код `422` — в
 * `v2-person-records-http.spec.ts`); п. 8 — инструктаж по охране труда истекает через 30 дней →
 * после `documents.expiry_scan` ушли уведомления человеку, руководителю точки и HR, статус
 * `expiring`. Плюс то, на чём эти два держатся: один действующий документ типа-«состояния»,
 * файл становится файлом человека, обязательный тип — доказательство, справочник типов — у HR.
 */

const D = await import('../../server/services/personDocuments')
const { addMonths, daysBetween } = await import('../../shared/domain/personRecords')
const { documentTypeCreateSchema } = await import('../../shared/schemas/personRecords')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, lazarevaId: string, posId: string, prevManagerId: string | null
let managerId: string, hrId: string, subjectId: string
let medicalBook: string, briefing: string, certificate: string, contract: string
const userIds: string[] = []
const mediaIds: string[] = []
const typeIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[]) => ({ userId, tenantId, grants, activeRole: null, roles: [] })
const ctx = (actorId: string) => ({ tenantId, actorId })
const DOC_SCOPES = ['person.document.view_others', 'person.document.manage']
const hrV = () => D.docViewerOf(access(hrId, [{ scopes: DOC_SCOPES, scopeType: 'tenant', scopeId: null }]))
const managerV = () => D.docViewerOf(access(managerId, [{ scopes: DOC_SCOPES, scopeType: 'location', scopeId: lazarevaId }]))
const subjectV = () => D.docViewerOf(access(subjectId, [{ scopes: ['learn.view'], scopeType: 'location', scopeId: lazarevaId }]))

const iso = (d: Date) => d.toISOString().slice(0, 10)
/**
 * «Сегодня» — по часовому поясу тенанта, как считает сам скан: около полуночи дата сервера БД
 * и дата Киева расходятся, и `current_date + 30` давал бы 29 дней до истечения.
 */
let today = ''
const inDays = (n: number) => iso(new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000))

async function makePerson(name: string) {
  const phone = `+38094${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, 'active') returning id`
  const id = u!.id as string
  userIds.push(id)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${lazarevaId}, ${posId}, true, current_date - 30)`
  return id
}

/** Файл «после загрузки»: как его оставляет `POST /media/upload-url` + `complete` — владелец = загрузивший. */
async function uploaded(ownerId: string, mime = 'application/pdf', bytes = 120_000) {
  const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin)
    values (${tenantId}, ${`t/${tenantId}/test/${stamp}-${mediaIds.length}.pdf`}, 'scan.pdf', 'file', ${mime}, ${bytes}, 'processing', ${ownerId}, 'person_document') returning id`
  mediaIds.push(m!.id as string)
  return m!.id as string
}

beforeAll(async () => {
  const [t] = await admin`select id, timezone from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  today = D.localDate(new Date(), (t!.timezone as string | null) ?? 'Europe/Kyiv')
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  prevManagerId = (await admin`select manager_id from locations where id = ${lazarevaId}`)[0]!.manager_id as string | null
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-docs-${stamp}`}, 'docs-pos') returning id`)[0]!.id as string
  managerId = await makePerson('Керівник точки документів')
  hrId = await makePerson('HR документів')
  subjectId = await makePerson('Кухар з документами')
  // «Руководитель точки» уведомления — руководитель точки основного размещения (§8)
  await admin`update locations set manager_id = ${managerId} where id = ${lazarevaId}`
  const types = await admin`select id, code from person_document_types where tenant_id = ${tenantId}`
  const byCode = Object.fromEntries(types.map(t => [t.code as string, t.id as string]))
  medicalBook = byCode.medical_book!
  briefing = byCode.labor_safety_briefing!
  certificate = byCode.external_certificate!
  contract = byCode.employment_contract!
})

afterAll(async () => {
  await admin`update locations set manager_id = ${prevManagerId} where id = ${lazarevaId}`
  await admin`delete from notifications where tenant_id = ${tenantId} and code like 'person_document_%'`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (action like 'person_document%' or entity_id in ${admin(userIds)})`
  await admin`update person_documents set replaced_by_id = null where user_id in ${admin(userIds)}`
  await admin`delete from person_documents where user_id in ${admin(userIds)}`
  if (typeIds.length) await admin`delete from person_document_types where id in ${admin(typeIds)}`
  if (mediaIds.length) {
    await admin`delete from usage_events where ref_id in ${admin(mediaIds)}`.catch(() => null)
    await admin`delete from media_assets where id in ${admin(mediaIds)}`
  }
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

describe('схема и справочник (§3.5)', () => {
  it('семь системных типов у тенанта; medical_book — факт без файла', async () => {
    const rows = await admin`select code, is_system, is_required, validity_months, is_fact_only, self_upload from person_document_types where tenant_id = ${tenantId} and is_system order by code`
    expect(rows.map(r => r.code)).toEqual(['employment_contract', 'external_certificate', 'fire_safety_briefing', 'labor_safety_briefing', 'medical_book', 'nda', 'other'])
    expect(rows.find(r => r.code === 'medical_book')).toMatchObject({ is_required: true, validity_months: 12, is_fact_only: true })
    expect(rows.find(r => r.code === 'external_certificate')).toMatchObject({ is_required: false, self_upload: true })
  })
})

describe('§13 п. 7: тип «лише факт» не принимает файл', () => {
  it('medical_book + mediaId → document_file_not_allowed, записи нет, файл не привязан', async () => {
    const mediaId = await uploaded(hrId, 'image/jpeg')
    const r = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: medicalBook, mediaId, issuedAt: inDays(-10), expiresAt: inDays(355), number: 'МК 00123456' })
    expect(r).toEqual({ ok: false, code: 'document_file_not_allowed' })
    const [n] = await admin`select count(*)::int as n from person_documents where user_id = ${subjectId} and type_id = ${medicalBook}`
    expect(n!.n).toBe(0)
    const [m] = await admin`select owner_user_id, source_id from media_assets where id = ${mediaId}`
    expect(m).toMatchObject({ owner_user_id: hrId, source_id: null })
  })

  it('тот же тип без файла — факт и срок, номер — последние 4 знака', async () => {
    const r = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: medicalBook, issuedAt: inDays(-10), expiresAt: inDays(355), number: 'МК 00123456' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.document).toMatchObject({ status: 'valid', numberMasked: '****3456', file: null })
    const [row] = await admin`select number_masked from person_documents where id = ${r.document.id}`
    expect(row!.number_masked).toBe('****3456') // полный номер не хранится нигде
  })

  it('тип с файлом без файла — document_file_required', async () => {
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: briefing, issuedAt: inDays(-1), expiresAt: inDays(364) }))
      .toEqual({ ok: false, code: 'document_file_required' })
  })
})

describe('§6.2 даты и файл', () => {
  it('выдан в будущем, истекает до выдачи, срок обязателен для типа со сроком', async () => {
    const mediaId = await uploaded(hrId)
    const base = { typeId: briefing, mediaId }
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { ...base, issuedAt: inDays(2), expiresAt: inDays(300) })).toEqual({ ok: false, code: 'document_dates_invalid', reason: 'issued_in_future' })
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { ...base, issuedAt: inDays(-2), expiresAt: inDays(-3) })).toEqual({ ok: false, code: 'document_dates_invalid', reason: 'expires_before_issued' })
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { ...base, issuedAt: inDays(-2), expiresAt: null })).toEqual({ ok: false, code: 'document_dates_invalid', reason: 'expires_required' })
  })

  it('чужой файл, не тот формат или уже привязанный — document_file_invalid', async () => {
    const foreign = await uploaded(managerId)
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: contract, mediaId: foreign, issuedAt: inDays(-1) })).toEqual({ ok: false, code: 'document_file_invalid' })
    const docx = await uploaded(hrId, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: contract, mediaId: docx, issuedAt: inDays(-1) })).toEqual({ ok: false, code: 'document_file_invalid' })
  })
})

describe('§4 один действующий; §7.8 файл становится файлом человека', () => {
  it('новый инструктаж отменяет прежний, историческая запись сама становится заменённой', async () => {
    const m1 = await uploaded(hrId)
    const first = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: briefing, mediaId: m1, issuedAt: inDays(-200), expiresAt: inDays(165) })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const [media] = await admin`select owner_user_id, source_entity, source_id, is_evidence, retention_until from media_assets where id = ${m1}`
    expect(media).toMatchObject({ owner_user_id: subjectId, source_entity: 'person_documents', source_id: first.document.id, is_evidence: true })
    expect(iso(media!.retention_until as Date)).toBe(addMonths(inDays(165), 36)) // expires_at + 3 роки (§7.8)
    expect(daysBetween(inDays(165), iso(media!.retention_until as Date))).toBeGreaterThanOrEqual(365 * 3)

    const m2 = await uploaded(hrId)
    const second = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: briefing, mediaId: m2, issuedAt: inDays(-5), expiresAt: inDays(360) })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const [old] = await admin`select status, replaced_by_id, revoked_at from person_documents where id = ${first.document.id}`
    expect(old).toMatchObject({ status: 'revoked', replaced_by_id: second.document.id })

    // Историческая запись, внесённая после текущей, текущую не отменяет
    const m3 = await uploaded(hrId)
    const historic = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: briefing, mediaId: m3, issuedAt: inDays(-400), expiresAt: inDays(-35) })
    expect(historic.ok).toBe(true)
    if (!historic.ok) return
    const [cur] = await admin`select status from person_documents where id = ${second.document.id}`
    expect(cur!.status).toBe('valid')
    const [hist] = await admin`select status, replaced_by_id from person_documents where id = ${historic.document.id}`
    expect(hist).toMatchObject({ status: 'revoked', replaced_by_id: second.document.id })
    const [active] = await admin`select count(*)::int as n from person_documents where user_id = ${subjectId} and type_id = ${briefing} and status <> 'revoked'`
    expect(active!.n).toBe(1)
  })

  it('сертификаты — коллекция: второй не отменяет первый', async () => {
    const a = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: certificate, mediaId: await uploaded(hrId), issuedAt: inDays(-30), title: 'Бариста-курс' })
    const b = await D.createPersonDocument(ctx(hrId), await hrV(), subjectId, { typeId: certificate, mediaId: await uploaded(hrId), issuedAt: inDays(-3), title: 'Санмінімум' })
    expect(a.ok && b.ok).toBe(true)
    const [n] = await admin`select count(*)::int as n from person_documents where user_id = ${subjectId} and type_id = ${certificate} and status <> 'revoked'`
    expect(n!.n).toBe(2)
  })
})

describe('§13 п. 8: documents.expiry_scan — истекает через 30 дней', () => {
  it('статус expiring, уведомления человеку, руководителю точки и HR', async () => {
    const [fire] = await admin`select id from person_document_types where tenant_id = ${tenantId} and code = 'fire_safety_briefing'`
    // Внесён со статусом valid «вчера», когда до истечения было 31 день — сегодня 30
    const [doc] = await admin`insert into person_documents (tenant_id, user_id, type_id, media_id, issued_at, expires_at, status, uploaded_by)
      values (${tenantId}, ${subjectId}, ${fire!.id}, ${await uploaded(hrId)}, ${inDays(-335)}, ${inDays(30)}, 'valid', ${hrId}) returning id`
    const docId = doc!.id as string

    const s = await D.documentsExpiryScanTenant(tenantId)
    expect(s.expiring).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select status from person_documents where id = ${docId}`
    expect(row!.status).toBe('expiring')

    const sent = await admin`select user_id, payload from notifications where code = 'person_document_expiring' and ref_id = ${docId}`
    const to = sent.map(r => r.user_id as string)
    expect(to).toContain(subjectId) // человеку
    expect(to).toContain(managerId) // руководителю точки
    expect(to).toContain(adminId) // HR — носитель person.document.manage на весь тенант (системная роль admin)
    const own = sent.find(r => r.user_id === subjectId)!.payload as Record<string, unknown>
    expect(own).toMatchObject({ days: 30 })
    expect(own.person).toBeUndefined() // человеку — о его документе, без имени
    expect((sent.find(r => r.user_id === managerId)!.payload as Record<string, unknown>).person).toMatch(/Кухар з документами/)

    // Повторный проход в тот же день — ни одного второго сообщения
    const again = await D.documentsExpiryScanTenant(tenantId)
    const [n] = await admin`select count(*)::int as n from notifications where code = 'person_document_expiring' and ref_id = ${docId}`
    expect(n!.n).toBe(sent.length)
    expect(again.expiring).toBe(0)
  })

  it('после даты — expired и person_document_expired; тип, скрытый от руководителя, ему не приходит', async () => {
    const [hidden] = await admin`insert into person_document_types (tenant_id, code, name, validity_months, visible_to_manager)
      values (${tenantId}, ${`hidden_${stamp}`}, 'Прихований від керівника', 12, false) returning id`
    typeIds.push(hidden!.id as string)
    const [doc] = await admin`insert into person_documents (tenant_id, user_id, type_id, media_id, issued_at, expires_at, status, uploaded_by)
      values (${tenantId}, ${subjectId}, ${hidden!.id}, ${await uploaded(hrId)}, ${inDays(-400)}, ${inDays(-1)}, 'expiring', ${hrId}) returning id`
    const s = await D.documentsExpiryScanTenant(tenantId)
    expect(s.expired).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select status from person_documents where id = ${doc!.id}`
    expect(row!.status).toBe('expired')
    const to = (await admin`select user_id from notifications where code = 'person_document_expired' and ref_id = ${doc!.id}`).map(r => r.user_id as string)
    expect(to).toContain(subjectId)
    expect(to).toContain(adminId)
    expect(to).not.toContain(managerId)
  })
})

describe('§2 права', () => {
  it('руководитель точки не видит типов, скрытых от руководителя; человек видит все свои', async () => {
    const [hidden] = await admin`select id from person_document_types where code = ${`hidden_${stamp}`}`
    const mine = await D.listPersonDocuments(ctx(subjectId), await subjectV(), subjectId)
    const theirs = await D.listPersonDocuments(ctx(managerId), await managerV(), subjectId)
    expect(mine.ok && theirs.ok).toBe(true)
    if (!mine.ok || !theirs.ok) return
    expect(mine.items.some(i => i.typeId === hidden!.id)).toBe(true)
    expect(theirs.items.some(i => i.typeId === hidden!.id)).toBe(false)
    expect(mine.items.every(i => !i.can.edit)).toBe(true) // сам себе документы не правит
    expect(mine.types.map(t => t.code)).toEqual(['external_certificate']) // себе — только self_upload
  })

  it('заглушки отсутствующих обязательных типов (§5.1, §7.8)', async () => {
    const r = await D.listPersonDocuments(ctx(hrId), await hrV(), subjectId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const missing = r.missing.map(m => m.code)
    expect(missing).toEqual(expect.arrayContaining(['employment_contract', 'nda']))
    expect(missing).not.toContain('medical_book') // есть (факт)
    expect(missing).not.toContain('labor_safety_briefing') // есть действующий
  })

  it('сам человек загружает себе только self_upload; документ помечен «Завантажено співробітником»', async () => {
    const own = await D.createPersonDocument(ctx(subjectId), await subjectV(), subjectId, { typeId: certificate, mediaId: await uploaded(subjectId), issuedAt: inDays(-1), title: 'Свій сертифікат' })
    expect(own.ok && own.document.selfUploaded).toBe(true)
    expect(await D.createPersonDocument(ctx(subjectId), await subjectV(), subjectId, { typeId: contract, mediaId: await uploaded(subjectId), issuedAt: inDays(-1) }))
      .toEqual({ ok: false, code: 'forbidden' })
  })
})

describe('§4 отмена, §10 удаление', () => {
  it('отмена — только с причиной и необратима; обязательный не удаляется, сертификат — удаляется', async () => {
    const r = await D.listPersonDocuments(ctx(hrId), await hrV(), subjectId)
    if (!r.ok) throw new Error('list')
    const active = r.items.find(i => i.type.code === 'labor_safety_briefing' && i.status !== 'revoked')!
    expect(await D.updatePersonDocument(ctx(hrId), await hrV(), subjectId, active.id, { status: 'revoked' })).toEqual({ ok: false, code: 'reason_required' })
    const revoked = await D.updatePersonDocument(ctx(hrId), await hrV(), subjectId, active.id, { status: 'revoked', reason: 'Інструктаж проведено формально' })
    expect(revoked.ok && revoked.document).toMatchObject({ status: 'revoked', revokeReason: 'Інструктаж проведено формально' })
    expect(await D.updatePersonDocument(ctx(hrId), await hrV(), subjectId, active.id, { expiresAt: inDays(900) })).toEqual({ ok: false, code: 'document_revoked' })

    expect(await D.deletePersonDocument(ctx(hrId), await hrV(), subjectId, active.id)).toEqual({ ok: false, code: 'document_is_evidence' })
    const cert = r.items.find(i => i.type.code === 'external_certificate')!
    const del = await D.deletePersonDocument(ctx(hrId), await hrV(), subjectId, cert.id)
    expect(del.ok).toBe(true)
    const [gone] = await admin`select count(*)::int as n from person_documents where id = ${cert.id}`
    expect(gone!.n).toBe(0)
  })

  it('продление срока пересчитывает состояние', async () => {
    const [fire] = await admin`select d.id from person_documents d join person_document_types t on t.id = d.type_id where d.user_id = ${subjectId} and t.code = 'fire_safety_briefing' and d.status = 'expiring'`
    const r = await D.updatePersonDocument(ctx(hrId), await hrV(), subjectId, fire!.id as string, { expiresAt: inDays(200) })
    expect(r.ok && r.document.status).toBe('valid')
  })
})

describe('справочник типов — HR (§2, §12)', () => {
  it('создать может только HR; системный не удаляется; используемый — выключается, но не удаляется', async () => {
    const input = documentTypeCreateSchema.parse({ name: 'Посвідчення водія', validityMonths: 120, remindDays: [7, 30, 0, 7] })
    expect(await D.createDocumentType(ctx(managerId), await managerV(), input)).toEqual({ ok: false, code: 'forbidden' })
    const created = await D.createDocumentType(ctx(hrId), await hrV(), input)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    typeIds.push(created.type.id)
    expect(created.type.code).toMatch(/^custom_[0-9a-f]{8}$/)
    expect(created.type.remindDays).toEqual([30, 7, 0])

    expect(await D.deleteDocumentType(ctx(hrId), await hrV(), contract)).toEqual({ ok: false, code: 'type_is_system' })
    const [hidden] = await admin`select id from person_document_types where code = ${`hidden_${stamp}`}`
    expect(await D.deleteDocumentType(ctx(hrId), await hrV(), hidden!.id as string)).toEqual({ ok: false, code: 'type_in_use', count: 1 })
    const off = await D.updateDocumentType(ctx(hrId), await hrV(), hidden!.id as string, { isActive: false })
    expect(off.ok && off.type.isActive).toBe(false)
    expect(await D.deleteDocumentType(ctx(hrId), await hrV(), created.type.id)).toEqual({ ok: true })
    typeIds.splice(typeIds.indexOf(created.type.id), 1)
  })
})
