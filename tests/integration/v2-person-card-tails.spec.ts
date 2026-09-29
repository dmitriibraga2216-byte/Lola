import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Хвосты карточки человека (docs/v2/38-people-extensions.md §7.4–§7.8, §7.13, §8, §11, §12):
 * `documents.missing_scan` + `person_document_missing`, `absence.balance_scan` +
 * `absence_norm_exceeded`, еженедельная переборка `notes.sensitive_screen` и выгрузка
 * персональных данных по запросу субъекта. HTTP-коды выгрузки — в `v2-person-records-http.spec.ts`.
 */

const D = await import('../../server/services/personDocuments')
const A = await import('../../server/services/absences')
const N = await import('../../server/services/personNotes')
const P = await import('../../server/services/personalDataExport')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, lazarevaId: string, posId: string, typeId: string, year: number
const userIds: string[] = []

async function makePerson(name: string, opts: { hiredDaysAgo?: number, kind?: 'employee' | 'candidate', status?: string } = {}) {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, kind, candidate_state, hired_at)
    values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, ${opts.status ?? 'active'}, ${opts.kind ?? 'employee'},
            ${opts.kind === 'candidate' ? 'active' : null},
            ${opts.hiredDaysAgo === undefined ? null : admin`current_date - ${opts.hiredDaysAgo}::int`}) returning id`
  const id = u!.id as string
  userIds.push(id)
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at)
    values (${tenantId}, ${id}, ${lazarevaId}, ${posId}, true, current_date - 30)`
  return id
}

beforeAll(async () => {
  const [t] = await admin`select id, timezone from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  year = Number((await admin`select extract(year from now() at time zone ${(t!.timezone as string | null) ?? 'Europe/Kyiv'})::int as y`)[0]!.y)
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-tails-${stamp}`}, 'tails-pos') returning id`)[0]!.id as string
  // Обязательный только для своей посады — чужие люди сида скан этого типа не задевают
  typeId = (await admin`insert into person_document_types (tenant_id, code, name, is_required, required_positions)
    values (${tenantId}, ${`tails_${stamp}`}, ${`Санмінімум ${stamp}`}, true, ${[posId]}::uuid[]) returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`delete from notifications where tenant_id = ${tenantId} and ref_id in ${admin(userIds)}`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (entity_id in ${admin(userIds)} or entity = 'user_notes' and after->>'userId' in ${admin(userIds)})`
  await admin`delete from user_notes where user_id in ${admin(userIds)}`
  await admin`delete from person_documents where user_id in ${admin(userIds)}`
  await admin`delete from absence_records where user_id in ${admin(userIds)}`
  await admin`delete from absence_norms where tenant_id = ${tenantId} and scope_id in ${admin(userIds)}`
  await admin`delete from person_rating_snapshots where user_id in ${admin(userIds)}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from person_document_types where id = ${typeId}`
  await admin`delete from positions where id = ${posId}`
  await admin.end()
})

const sentTo = async (code: string, personId: string) =>
  (await admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = ${code} and ref_id = ${personId}`)
    .map(r => ({ userId: r.user_id as string, payload: r.payload as Record<string, unknown> }))

describe('documents.missing_scan — обязательный документ не внесён 7 дней после приёма (§8, §11)', () => {
  // У сида свои обязательные типы для всех посад (трудовий договір) — смотрим только свой тип
  const missingOf = async (personId: string) => (await sentTo('person_document_missing', personId)).filter(r => r.payload.typeId === typeId)
  it('HR получает person_document_missing один раз; новичок, у кого документ есть, кандидат и уволенный — нет', async () => {
    const late = await makePerson('Без санмінімуму', { hiredDaysAgo: 10 })
    const fresh = await makePerson('Новачок', { hiredDaysAgo: 3 })
    const covered = await makePerson('З документом', { hiredDaysAgo: 30 })
    const candidate = await makePerson('Кандидат', { hiredDaysAgo: 30, kind: 'candidate' })
    const gone = await makePerson('Звільнений', { hiredDaysAgo: 30, status: 'archived' })
    await admin`insert into person_documents (tenant_id, user_id, type_id, issued_at, status, uploaded_by)
      values (${tenantId}, ${covered}, ${typeId}, current_date - 20, 'valid', ${adminId})`

    const s = await D.documentsMissingScanTenant(tenantId)
    expect(s.missing).toBeGreaterThanOrEqual(1)
    const toLate = await missingOf(late)
    expect(toLate.map(r => r.userId)).toContain(adminId) // HR — person.document.manage на весь тенант
    expect(toLate.map(r => r.userId)).not.toContain(late) // самому человеку §8 не пишет
    expect(toLate[0]!.payload).toMatchObject({ type: `Санмінімум ${stamp}`, personId: late })
    expect(String(toLate[0]!.payload.person)).toContain('Без санмінімуму')
    for (const id of [covered]) expect(await missingOf(id)).toEqual([])
    for (const id of [fresh, candidate, gone]) expect(await sentTo('person_document_missing', id)).toEqual([])

    // Повтор назавтра — без второго сообщения (Р-38.1)
    await D.documentsMissingScanTenant(tenantId, new Date(Date.now() + 86_400_000))
    expect((await missingOf(late)).length).toBe(toLate.length)
  })

  it('отменённый документ не считается внесённым', async () => {
    const revoked = await makePerson('Скасований документ', { hiredDaysAgo: 40 })
    await admin`insert into person_documents (tenant_id, user_id, type_id, issued_at, status, uploaded_by, revoked_at, revoke_reason)
      values (${tenantId}, ${revoked}, ${typeId}, current_date - 20, 'revoked', ${adminId}, now(), 'помилка')`
    await D.documentsMissingScanTenant(tenantId)
    expect((await missingOf(revoked)).map(r => r.userId)).toContain(adminId)
  })
})

describe('absence.balance_scan — отрицательный остаток (§7.13, §8, §12)', () => {
  const approved = (userId: string, kind: string, from: string, to: string, days: number, status = 'approved') =>
    admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, status, created_by)
      values (${tenantId}, ${userId}, ${kind}, ${from}, ${to}, ${days}, ${status}, ${adminId})`

  it('норма 5, использовано 8 → HR получает absence_norm_exceeded с −3; тот же остаток назавтра — тишина, новый перерасход — новое', async () => {
    const over = await makePerson('Перевитрата відпустки', { hiredDaysAgo: 300 })
    await admin`insert into absence_norms (tenant_id, scope_type, scope_id, year, vacation_days, reason, set_by)
      values (${tenantId}, 'user', ${over}, ${year}, 5, 'Перевірка скану', ${adminId})`
    await approved(over, 'vacation', `${year}-01-10`, `${year}-01-17`, 8)
    // Не входят: запланированное и неоплачиваемое (у него нормы нет)
    await approved(over, 'vacation', `${year}-02-01`, `${year}-02-10`, 10, 'planned')
    await approved(over, 'unpaid', `${year}-03-01`, `${year}-03-20`, 20)

    const s = await A.absenceBalanceScanTenant(tenantId, year)
    expect(s.negative).toBeGreaterThanOrEqual(1)
    const first = await sentTo('absence_norm_exceeded', over)
    expect(first.map(r => r.userId)).toContain(adminId)
    expect(first.map(r => r.userId)).not.toContain(over)
    expect(first[0]!.payload).toMatchObject({ kind: 'vacation', vacation: true, days: -3, year })

    await A.absenceBalanceScanTenant(tenantId, year)
    expect((await sentTo('absence_norm_exceeded', over)).length).toBe(first.length)

    await approved(over, 'vacation', `${year}-04-01`, `${year}-04-02`, 2)
    await A.absenceBalanceScanTenant(tenantId, year)
    const second = await sentTo('absence_norm_exceeded', over)
    expect(second.length).toBe(first.length * 2)
    expect(second.map(r => r.payload.days)).toContain(-5)
  })

  it('в пределах нормы, кандидат и уволенный — без уведомлений; дни прошлого года не входят', async () => {
    const ok = await makePerson('У межах норми', { hiredDaysAgo: 300 })
    await approved(ok, 'vacation', `${year - 1}-12-20`, `${year}-01-05`, 17) // в этом году — 5 из 24 по умолчанию
    await approved(ok, 'sick', `${year}-05-01`, `${year}-05-05`, 5) // 5 из 5 — ноль, не минус
    const gone = await makePerson('Звільнений у відпустці', { hiredDaysAgo: 300, status: 'archived' })
    await approved(gone, 'sick', `${year}-05-01`, `${year}-05-20`, 20)
    await A.absenceBalanceScanTenant(tenantId, year)
    expect(await sentTo('absence_norm_exceeded', ok)).toEqual([])
    expect(await sentTo('absence_norm_exceeded', gone)).toEqual([])
  })
})

describe('notes.sensitive_screen — еженедельная переборка по словарю (§7.5, §11)', () => {
  it('ставит flagged_at действующей заметке и уведомляет администраторов; архивную и уволенного не трогает', async () => {
    const author = await makePerson('Автор нотаток', { hiredDaysAgo: 100 })
    const subject = await makePerson('Про кого нотатка', { hiredDaysAgo: 100 })
    const gone = await makePerson('Звільнений з нотаткою', { hiredDaysAgo: 100, status: 'archived' })
    const note = async (userId: string, body: string, archived = false) => (await admin`insert into user_notes (tenant_id, user_id, author_id, body, archived_at)
      values (${tenantId}, ${userId}, ${author}, ${body}, ${archived ? admin`now()` : null}) returning id`)[0]!.id as string
    const hit = await note(subject, 'Має діагноз, просить зсунути зміни')
    const clean = await note(subject, 'Домовились про наставника на квітень')
    const archivedHit = await note(subject, 'Лікування після травми', true)
    const goneHit = await note(gone, 'Вагітність, переходить на півставки')

    const s = await N.sensitiveScreenTenant(tenantId)
    expect(s.flagged).toBeGreaterThanOrEqual(1)
    const rows = await admin`select id, flagged_at, flagged_terms from user_notes where id in ${admin([hit, clean, archivedHit, goneHit])}`
    const by = Object.fromEntries(rows.map(r => [r.id as string, r]))
    expect(by[hit]!.flagged_at).not.toBeNull()
    expect(by[hit]!.flagged_terms).toContain('діагноз')
    for (const id of [clean, archivedHit, goneHit]) expect(by[id]!.flagged_at).toBeNull()
    expect((await sentTo('person_note_flagged', subject)).map(r => r.userId)).toContain(adminId)
    const [log] = await admin`select after from audit_log where action = 'person_note.flag' and entity_id = ${hit}`
    expect(log!.after).toMatchObject({ userId: subject, signs: ['health'], source: 'sensitive_screen' })

    // Повторный проход отмеченную заметку не перебирает
    const again = await N.sensitiveScreenTenant(tenantId)
    const [n] = await admin`select count(*)::int as n from audit_log where action = 'person_note.flag' and entity_id = ${hit}`
    expect(n!.n).toBe(1)
    expect(again.screened).toBeLessThan(s.screened)
  })
})

describe('выгрузка персональных данных по запросу субъекта (§7.4, §7.6, §12)', () => {
  it('все заметки (включая hr и архивные) и факты чтения без имён читавших; журнал с основанием', async () => {
    const reader = await makePerson('Читач-керівник', { hiredDaysAgo: 200 })
    const subject = await makePerson('Суб\'єкт даних', { hiredDaysAgo: 200 })
    await admin`insert into user_notes (tenant_id, user_id, author_id, body, visibility) values (${tenantId}, ${subject}, ${reader}, 'Службова нотатка HR про графік', 'hr')`
    await admin`insert into user_notes (tenant_id, user_id, author_id, body, archived_at) values (${tenantId}, ${subject}, ${reader}, 'Стара архівна нотатка', now())`
    await admin`insert into audit_log (tenant_id, actor_id, action, entity, entity_id, after)
      values (${tenantId}, ${reader}, 'person_note.read', 'user', ${subject}, ${admin.json({ user_id: subject, note_ids: [], count: 2 })})`
    await admin`insert into absence_records (tenant_id, user_id, kind, date_from, date_to, days_count, created_by)
      values (${tenantId}, ${subject}, 'sick', ${`${year}-06-01`}, ${`${year}-06-03`}, 3, ${reader})`
    await admin`insert into person_documents (tenant_id, user_id, type_id, issued_at, status, uploaded_by, number_masked)
      values (${tenantId}, ${subject}, ${typeId}, current_date - 5, 'valid', ${reader}, '****1234')`

    const r = await P.exportPersonalData({ tenantId, actorId: adminId }, subject, 'Запит №12 від 29.09')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.data
    expect(d.profile).toMatchObject({ id: subject, kind: 'employee' })
    expect(d.notes.map(n => n.body)).toEqual(expect.arrayContaining(['Службова нотатка HR про графік', 'Стара архівна нотатка']))
    expect(d.notes.every(n => n.written_by_you === false)).toBe(true)
    expect(d.noteReads).toEqual([expect.objectContaining({ count: 2 })])
    expect(d.absences).toHaveLength(1)
    expect(d.documents[0]).toMatchObject({ number_masked: '****1234', uploaded_by_you: false })
    expect(d.placements[0]).toMatchObject({ location: 'Лазарева' })
    // Имён и идентификаторов других людей в файле нет (Р-38.5)
    const text = JSON.stringify(d)
    expect(text).not.toContain('Читач-керівник')
    expect(text).not.toContain(reader)

    const [log] = await admin`select actor_id, after from audit_log where action = 'person.personal_data_export' and entity_id = ${subject}`
    expect(log!.actor_id).toBe(adminId)
    expect(log!.after).toMatchObject({ reason: 'Запит №12 від 29.09', counts: { notes: 2, noteReads: 1, absences: 1, documents: 1 } })
    expect(JSON.stringify(log!.after)).not.toContain('Службова нотатка')
  })

  it('кандидат, несуществующий и мусорный id — not_found, журнал не пишется', async () => {
    const candidate = await makePerson('Кандидат-ПД', { kind: 'candidate' })
    for (const id of [candidate, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect(await P.exportPersonalData({ tenantId, actorId: adminId }, id, 'Запит')).toEqual({ ok: false, code: 'not_found' })
    }
    const [n] = await admin`select count(*)::int as n from audit_log where action = 'person.personal_data_export' and entity_id = ${candidate}`
    expect(n!.n).toBe(0)
  })
})
