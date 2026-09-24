import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Заметки о человеке (docs/v2/38-people-extensions.md §3.4, §4, §7.4–§7.6; PR-32).
 *
 * Критерии приёмки §13: п. 4 — руководитель открыл «Нотатки» чужой карточки → в `audit_log`
 * `person_note.read` с перечнем `note_ids` и **без текста**; п. 5 — сужение видимости открытой
 * человеку заметки → `visibility_narrowing_forbidden` (HTTP-код `409` — в
 * `v2-person-records-http.spec.ts`); п. 6 — заметке 25 месяцев, категория `performance`,
 * `notes.archive_scan` → `archived_at` заполнен, из ленты исчезла, администратору доступна по
 * прямой ссылке. Плюс правила видимости §7.4, которые делают п. 4 осмысленным: HR-заметка
 * руководителю не видна, сам человек видит счётчик всех и текст только открытых, перевод на
 * другую точку снимает доступ прежнего руководителя в тот же день.
 */

const N = await import('../../server/services/personNotes')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now()
let tenantId: string, adminId: string, lazarevaId: string, segedskaId: string, posId: string
let managerId: string, manager2Id: string, hrId: string, subjectId: string, otherTenantId: string
const userIds: string[] = []

type Grant = { scopes: string[], scopeType: 'tenant' | 'location' | 'org_unit', scopeId: string | null }
const access = (userId: string, grants: Grant[]) => ({ userId, tenantId, grants, activeRole: null, roles: [] })
/**
 * «С этого момента» — по часам базы, а не Node: `audit_log.created_at` ставит Postgres, и часы
 * контейнера расходятся с часами хоста на миллисекунды — граница по `new Date()` захватывала
 * запись предыдущего теста.
 */
const dbNow = async () => (await admin`select clock_timestamp() as now`)[0]!.now as Date
const ctx = (actorId: string) => ({ tenantId, actorId })
const NOTE_SCOPES = ['person.note.read', 'person.note.write']

async function makePerson(name: string, locationId: string | null) {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, ${`${name}-${stamp}`}, 'active') returning id`
  const id = u!.id as string
  userIds.push(id)
  if (locationId) await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${id}, ${locationId}, ${posId}, true, current_date - 30)`
  return id
}

// Руководитель точки: роль с заметками на точку; HR: те же скоупы на весь тенант, без audit.view;
// администратор: системная роль admin на весь тенант (заметки + audit.view)
const managerV = () => N.noteViewerOf(access(managerId, [{ scopes: NOTE_SCOPES, scopeType: 'location', scopeId: lazarevaId }]))
const manager2V = () => N.noteViewerOf(access(manager2Id, [{ scopes: NOTE_SCOPES, scopeType: 'location', scopeId: segedskaId }]))
const hrV = () => N.noteViewerOf(access(hrId, [{ scopes: NOTE_SCOPES, scopeType: 'tenant', scopeId: null }]))
const adminV = () => N.noteViewerOf(access(adminId, [{ scopes: [...NOTE_SCOPES, 'audit.view'], scopeType: 'tenant', scopeId: null }]))
const subjectV = () => N.noteViewerOf(access(subjectId, [{ scopes: ['learn.view'], scopeType: 'location', scopeId: lazarevaId }]))

async function note(by: 'manager' | 'hr' | 'admin', body: string, extra: Partial<{ visibility: 'hr' | 'manager' | 'shared_with_person', category: 'general' | 'performance' | 'agreement', isPinned: boolean, confirmSensitive: boolean }> = {}) {
  const who = by === 'manager' ? managerId : by === 'hr' ? hrId : adminId
  const v = by === 'manager' ? await managerV() : by === 'hr' ? await hrV() : await adminV()
  const r = await N.createPersonNote(ctx(who), v, subjectId, { body, category: 'general', visibility: 'manager', isPinned: false, confirmSensitive: false, ...extra })
  if (!r.ok) throw new Error(`note: ${r.code}`)
  return r.note
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  lazarevaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`)[0]!.id as string
  segedskaId = (await admin`select id from locations where tenant_id = ${tenantId} and name = 'Сегедська'`)[0]!.id as string
  posId = (await admin`insert into positions (tenant_id, name, code) values (${tenantId}, ${`Посада-notes-${stamp}`}, 'notes-pos') returning id`)[0]!.id as string
  managerId = await makePerson('Керівник Лазаревої', lazarevaId)
  manager2Id = await makePerson('Керівник Сегедської', segedskaId)
  hrId = await makePerson('HR мережі', lazarevaId)
  subjectId = await makePerson('Кухар про якого нотатки', lazarevaId)
  otherTenantId = (await admin`insert into tenants (slug, name) values (${`notes-iso-${stamp}`}, 'Ізоляція нотаток') returning id`)[0]!.id as string
})

afterAll(async () => {
  await admin`delete from notifications where tenant_id = ${tenantId} and code in ('person_note_shared', 'person_note_flagged')`
  await admin`delete from audit_log where tenant_id = ${tenantId} and (entity_id in ${admin(userIds)} or action like 'person_note.%')`
  await admin`delete from user_notes where user_id in ${admin(userIds)}`
  await admin`delete from user_placements where user_id in ${admin(userIds)}`
  await admin`delete from users where id in ${admin(userIds)}`
  await admin`delete from positions where id = ${posId}`
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

describe('схема: alter user_notes, а не новая person_notes (docs/v2/43 §1.2)', () => {
  it('семь колонок, четыре check, частичный индекс и полный рядом', async () => {
    const cols = await admin`select column_name from information_schema.columns where table_name = 'user_notes'`
    const names = cols.map(c => c.column_name as string)
    for (const c of ['visibility', 'category', 'is_pinned', 'flagged_at', 'flagged_terms', 'shared_at', 'archived_at']) expect(names).toContain(c)
    const checks = await admin`select conname from pg_constraint where conrelid = 'user_notes'::regclass and contype = 'c' order by conname`
    expect(checks.map(c => c.conname)).toEqual(['user_notes_body_chk', 'user_notes_category_chk', 'user_notes_self_chk', 'user_notes_visibility_chk'])
    const idx = await admin`select indexname, indexdef from pg_indexes where tablename = 'user_notes' and indexname like 'idx_user_notes_%' order by indexname`
    expect(idx.map(i => i.indexname)).toEqual(['idx_user_notes_tenant', 'idx_user_notes_tenant_all'])
    expect(String(idx[0]!.indexdef)).toMatch(/WHERE \(archived_at IS NULL\)/)
    expect(String(idx[1]!.indexdef)).not.toMatch(/WHERE/)
    const [person] = await admin`select count(*)::int as n from pg_tables where tablename = 'person_notes'`
    expect(person!.n).toBe(0)
  })

  it('БД сама отвергает заметку о себе и текст короче трёх знаков', async () => {
    await expect(admin`insert into user_notes (tenant_id, user_id, author_id, body) values (${tenantId}, ${subjectId}, ${subjectId}, 'про себе')`).rejects.toThrow(/user_notes_self_chk/)
    await expect(admin`insert into user_notes (tenant_id, user_id, author_id, body) values (${tenantId}, ${subjectId}, ${managerId}, 'ок')`).rejects.toThrow(/user_notes_body_chk/)
  })
})

describe('§13 п. 4: чтение заметок пишет журнал — перечень note_ids, без текста', () => {
  it('руководитель открыл «Нотатки» чужой карточки → person_note.read', async () => {
    const secret = `Домовились перенести атестацію на 12.03 — ${stamp}`
    const n1 = await note('manager', secret)
    const n2 = await note('hr', `Службова HR-нотатка ${stamp}`, { visibility: 'hr' })
    const since = await dbNow()
    const r = await N.listPersonNotes(ctx(managerId), await managerV(), subjectId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.items.map(i => i.id)
    expect(ids).toContain(n1.id)
    expect(ids).not.toContain(n2.id) // §7.4: уровень `hr` руководителю точки не виден

    const rows = await admin`select action, entity, entity_id, actor_id, after::text as after_text, after from audit_log
      where tenant_id = ${tenantId} and action = 'person_note.read' and actor_id = ${managerId} and created_at >= ${since}`
    expect(rows).toHaveLength(1) // одна запись на разворот секции
    const row = rows[0]!
    expect(row.entity).toBe('user')
    expect(row.entity_id).toBe(subjectId)
    expect(row.after).toMatchObject({ user_id: subjectId, count: ids.length })
    expect((row.after as { note_ids: string[] }).note_ids.sort()).toEqual([...ids].sort())
    expect(String(row.after_text)).not.toContain(secret)
    expect(String(row.after_text)).not.toContain('Домовились')
  })

  it('лента страницами по ключевому курсору: закреплённые первыми, без дублей и потерь, журнал — на каждую страницу', async () => {
    const [pinned] = await admin`insert into user_notes (tenant_id, user_id, author_id, body, is_pinned, created_at)
      values (${tenantId}, ${subjectId}, ${hrId}, ${`Закріплена давня ${stamp}`}, true, now() - interval '400 days') returning id`
    // Пачка одной транзакции — один created_at на всех: второй ключ (id) обязан держать границу страниц
    await admin`insert into user_notes (tenant_id, user_id, author_id, body, created_at)
      select ${tenantId}, ${subjectId}, ${hrId}, 'Пачка ' || g || ${` ${stamp}`}::text, now() - interval '1 day' from generate_series(1, 5) g`
    const all: string[] = []
    let cursor: string | undefined
    let pages = 0
    const since = await dbNow()
    do {
      const r = await N.listPersonNotes(ctx(hrId), await hrV(), subjectId, { cursor, limit: 2 })
      if (!r.ok) throw new Error(r.code)
      all.push(...r.items.map(i => i.id))
      cursor = r.cursor ?? undefined
      pages++
    } while (cursor && pages < 50)
    expect(all[0]).toBe(pinned!.id) // закреплённая — первой, несмотря на возраст
    expect(new Set(all).size).toBe(all.length) // без дублей
    const [n] = await admin`select count(*)::int as n from user_notes where user_id = ${subjectId} and archived_at is null`
    expect(all.length).toBe(n!.n) // без потерь
    const [reads] = await admin`select count(*)::int as n from audit_log where action = 'person_note.read' and actor_id = ${hrId} and created_at >= ${since}`
    expect(reads!.n).toBe(pages)
    await admin`update user_notes set is_pinned = false where id = ${pinned!.id}`
  })

  it('счётчик свёрнутой секции журнал не пишет — нечего ещё читать', async () => {
    const since = await dbNow()
    const c = await N.countPersonNotes(ctx(managerId), await managerV(), subjectId)
    expect(c.ok && c.total).toBeGreaterThan(0)
    const [n] = await admin`select count(*)::int as n from audit_log where tenant_id = ${tenantId} and action = 'person_note.read' and actor_id = ${managerId} and created_at >= ${since}`
    expect(n!.n).toBe(0)
  })
})

describe('§7.4 видимость', () => {
  it('сам человек видит счётчик всех своих заметок и текст только открытых', async () => {
    const shared = await note('manager', `Відкрито людині ${stamp}`, { visibility: 'shared_with_person' })
    const r = await N.listPersonNotes(ctx(subjectId), await subjectV(), subjectId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map(i => i.id)).toEqual([shared.id])
    const [all] = await admin`select count(*)::int as n from user_notes where user_id = ${subjectId} and archived_at is null`
    expect(r.total).toBe(all!.n) // существование не скрывается
    expect(r.canCreate).toBe(false) // о себе не пишут
    expect(r.items[0]!.can).toEqual({ edit: false, delete: false })
  })

  it('открытие человеку: shared_at, журнал person_note.share, уведомление person_note_shared', async () => {
    const n = await note('manager', `Буде відкрито ${stamp}`)
    const r = await N.updatePersonNote(ctx(managerId), await managerV(), subjectId, n.id, { visibility: 'shared_with_person', confirmSensitive: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.note.sharedAt).not.toBeNull()
    const [a] = await admin`select count(*)::int as n from audit_log where action = 'person_note.share' and entity_id = ${n.id}`
    expect(a!.n).toBe(1)
    const [msg] = await admin`select count(*)::int as n from notifications where user_id = ${subjectId} and code = 'person_note_shared' and dedup_key = ${`person_note_shared:${n.id}`}`
    expect(msg!.n).toBe(1)
  })

  it('руководитель чужой точки не видит ничего, кроме своих заметок; перевод снимает доступ в тот же день', async () => {
    const r2 = await N.listPersonNotes(ctx(manager2Id), await manager2V(), subjectId)
    expect(r2.ok && r2.items.length).toBe(0)
    // Человека перевели на Сегедську: руководитель Лазаревої теряет доступ к его manager-заметкам,
    // руководитель Сегедської — получает (§7.4: заметка не копируется, доступ идёт за точкой)
    await admin`update user_placements set location_id = ${segedskaId} where user_id = ${subjectId}`
    try {
      const mine = await N.listPersonNotes(ctx(managerId), await managerV(), subjectId)
      expect(mine.ok).toBe(true)
      if (mine.ok) expect(mine.items.every(i => i.author?.id === managerId)).toBe(true) // только свои — автор остаётся автором
      const theirs = await N.listPersonNotes(ctx(manager2Id), await manager2V(), subjectId)
      expect(theirs.ok && theirs.items.length).toBeGreaterThan(0)
      if (theirs.ok) expect(theirs.items.every(i => i.visibility !== 'hr')).toBe(true)
    }
    finally {
      await admin`update user_placements set location_id = ${lazarevaId} where user_id = ${subjectId}`
    }
  })

  it('уволенный: заметки только для чтения и только HR и администратору (§7.6)', async () => {
    await admin`update users set status = 'archived' where id = ${subjectId}`
    try {
      expect(await N.listPersonNotes(ctx(managerId), await managerV(), subjectId)).toEqual({ ok: false, code: 'forbidden' })
      const hr = await N.listPersonNotes(ctx(hrId), await hrV(), subjectId)
      expect(hr.ok).toBe(true)
      if (hr.ok) expect(hr.items.every(i => !i.can.edit)).toBe(true)
      const add = await N.createPersonNote(ctx(hrId), await hrV(), subjectId, { body: 'Нова після звільнення', category: 'general', visibility: 'hr', isPinned: false, confirmSensitive: false })
      expect(add).toEqual({ ok: false, code: 'person_archived' })
    }
    finally {
      await admin`update users set status = 'active' where id = ${subjectId}`
    }
  })

  it('чужой тенант и кандидат — not_found; о себе писать нельзя', async () => {
    const foreign = await N.noteViewerOf({ userId: adminId, tenantId: otherTenantId, grants: [{ scopes: NOTE_SCOPES, scopeType: 'tenant', scopeId: null }], activeRole: null, roles: [] })
    expect(await N.listPersonNotes({ tenantId: otherTenantId, actorId: adminId }, foreign, subjectId)).toEqual({ ok: false, code: 'not_found' })
    const [cand] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'candidate' limit 1`
    if (cand) expect(await N.listPersonNotes(ctx(hrId), await hrV(), cand.id as string)).toEqual({ ok: false, code: 'not_found' })
    const self = await N.createPersonNote(ctx(managerId), await managerV(), managerId, { body: 'Про себе самого', category: 'general', visibility: 'manager', isPinned: false, confirmSensitive: false })
    expect(self).toEqual({ ok: false, code: 'forbidden' })
    expect(await N.listPersonNotes(ctx(hrId), await hrV(), 'not-a-uuid')).toEqual({ ok: false, code: 'not_found' })
  })
})

describe('§4, §13 п. 5: видимость не сужается после показа человеку', () => {
  it('shared_with_person → manager — visibility_narrowing_forbidden; manager ⇄ hr — можно', async () => {
    const n = await note('manager', `Показано ${stamp}`, { visibility: 'shared_with_person' })
    const narrow = await N.updatePersonNote(ctx(managerId), await managerV(), subjectId, n.id, { visibility: 'manager', confirmSensitive: false })
    expect(narrow).toEqual({ ok: false, code: 'visibility_narrowing_forbidden' })
    const toHr = await N.updatePersonNote(ctx(adminId), await adminV(), subjectId, n.id, { visibility: 'hr', confirmSensitive: false })
    expect(toHr).toEqual({ ok: false, code: 'visibility_narrowing_forbidden' })
    const [row] = await admin`select visibility from user_notes where id = ${n.id}`
    expect(row!.visibility).toBe('shared_with_person')

    const m = await note('manager', `Поки для керівника ${stamp}`)
    const down = await N.updatePersonNote(ctx(managerId), await managerV(), subjectId, m.id, { visibility: 'hr', confirmSensitive: false })
    expect(down.ok && down.note.visibility).toBe('hr')
    const [log] = await admin`select before, after from audit_log where action = 'person_note.visibility_change' and entity_id = ${m.id}`
    expect(log).toMatchObject({ before: { visibility: 'manager' }, after: { visibility: 'hr' } })
  })

  it('чужую заметку правит только администратор; руководитель — forbidden', async () => {
    const n = await note('hr', `HR для керівника ${stamp}`)
    expect(await N.updatePersonNote(ctx(managerId), await managerV(), subjectId, n.id, { body: 'Правка чужої нотатки', confirmSensitive: false })).toEqual({ ok: false, code: 'forbidden' })
    const r = await N.updatePersonNote(ctx(adminId), await adminV(), subjectId, n.id, { body: 'Правка адміністратора', confirmSensitive: false })
    expect(r.ok && r.note.body).toBe('Правка адміністратора')
    const [log] = await admin`select before, after from audit_log where action = 'person_note.update' and entity_id = ${n.id}`
    expect(log).toMatchObject({ before: { body: `HR для керівника ${stamp}` }, after: { body: 'Правка адміністратора' } })
  })
})

describe('§3.4 не больше трёх закреплённых; §7.5 скрин не блокирует', () => {
  it('четвёртая закреплённая — pinned_limit', async () => {
    await admin`update user_notes set is_pinned = false where user_id = ${subjectId}`
    for (let i = 0; i < 3; i++) await note('hr', `Закріплена ${i} ${stamp}`, { isPinned: true, category: 'agreement' })
    const fourth = await N.createPersonNote(ctx(hrId), await hrV(), subjectId, { body: 'Четверта закріплена', category: 'agreement', visibility: 'manager', isPinned: true, confirmSensitive: false })
    expect(fourth).toEqual({ ok: false, code: 'pinned_limit' })
    await admin`update user_notes set is_pinned = false where user_id = ${subjectId}`
  })

  it('чувствительный текст: без подтверждения — sensitive с признаками; с подтверждением — flagged_at и уведомление администраторам', async () => {
    const body = `Хворів два тижні, вагітність дружини — переносимо дедлайн ${stamp}`
    const first = await N.createPersonNote(ctx(managerId), await managerV(), subjectId, { body, category: 'general', visibility: 'manager', isPinned: false, confirmSensitive: false })
    expect(first.ok).toBe(false)
    if (first.ok || first.code !== 'sensitive') throw new Error('ожидался sensitive')
    expect(first.signs).toEqual(expect.arrayContaining(['health', 'pregnancy']))
    const [none] = await admin`select count(*)::int as n from user_notes where body = ${body}`
    expect(none!.n).toBe(0) // до подтверждения не сохранено

    const saved = await N.createPersonNote(ctx(managerId), await managerV(), subjectId, { body, category: 'general', visibility: 'manager', isPinned: false, confirmSensitive: true })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const [row] = await admin`select flagged_at, flagged_terms from user_notes where id = ${saved.note.id}`
    expect(row!.flagged_at).not.toBeNull()
    expect(row!.flagged_terms).toEqual(expect.arrayContaining(['хворів', 'вагітність']))
    const [msg] = await admin`select count(*)::int as n from notifications where code = 'person_note_flagged' and user_id = ${adminId} and dedup_key = ${`person_note_flagged:${saved.note.id}:${adminId}`}`
    expect(msg!.n).toBe(1)

    // Переписал без чувствительного — отметка снимается
    const clean = await N.updatePersonNote(ctx(managerId), await managerV(), subjectId, saved.note.id, { body: `Переносимо дедлайн атестації ${stamp}`, confirmSensitive: false })
    expect(clean.ok && clean.note.flagged).toBe(false)
  })
})

describe('§2 удаление', () => {
  it('свою — автор; чужую — только администратор и только с причиной', async () => {
    const own = await note('manager', `Видалю сам ${stamp}`)
    expect(await N.deletePersonNote(ctx(managerId), await managerV(), subjectId, own.id)).toEqual({ ok: true })
    const foreign = await note('hr', `Чужа ${stamp}`)
    expect(await N.deletePersonNote(ctx(managerId), await managerV(), subjectId, foreign.id)).toEqual({ ok: false, code: 'forbidden' })
    expect(await N.deletePersonNote(ctx(adminId), await adminV(), subjectId, foreign.id)).toEqual({ ok: false, code: 'reason_required' })
    expect(await N.deletePersonNote(ctx(adminId), await adminV(), subjectId, foreign.id, 'Помилково внесено')).toEqual({ ok: true })
    const [log] = await admin`select before, after from audit_log where action = 'person_note.delete' and entity_id = ${foreign.id}`
    expect(log).toMatchObject({ before: { body: `Чужа ${stamp}` }, after: { reason: 'Помилково внесено' } })
  })
})

describe('§13 п. 6: notes.archive_scan по сроку хранения', () => {
  it('performance 25 месяцев → архив; из ленты исчезла; администратор видит по ссылке, руководитель — нет', async () => {
    const [old] = await admin`insert into user_notes (tenant_id, user_id, author_id, body, category, created_at)
      values (${tenantId}, ${subjectId}, ${managerId}, ${`Стара нотатка про результати ${stamp}`}, 'performance', now() - interval '25 months') returning id`
    const [agreement] = await admin`insert into user_notes (tenant_id, user_id, author_id, body, category, created_at)
      values (${tenantId}, ${subjectId}, ${managerId}, ${`Домовленість про розвиток ${stamp}`}, 'agreement', now() - interval '25 months') returning id`
    const oldId = old!.id as string

    const n = await N.archiveNotesTenant(tenantId)
    expect(n).toBeGreaterThanOrEqual(1)
    const [row] = await admin`select archived_at from user_notes where id = ${oldId}`
    expect(row!.archived_at).not.toBeNull()
    const [kept] = await admin`select archived_at from user_notes where id = ${agreement!.id}`
    expect(kept!.archived_at).toBeNull() // agreement — 36 месяцев (§7.6)
    const [log] = await admin`select after from audit_log where action = 'person_note.archive' and entity_id = ${oldId}`
    expect(log!.after).toMatchObject({ category: 'performance', retentionMonths: 24 })

    const list = await N.listPersonNotes(ctx(adminId), await adminV(), subjectId)
    expect(list.ok && list.items.map(i => i.id)).not.toContain(oldId)
    const direct = await N.getPersonNote(ctx(adminId), await adminV(), subjectId, oldId)
    expect(direct.ok && direct.note.archivedAt).not.toBeNull()
    expect(await N.getPersonNote(ctx(managerId), await managerV(), subjectId, oldId)).toEqual({ ok: false, code: 'not_found' })
    expect(await N.getPersonNote(ctx(hrId), await hrV(), subjectId, oldId)).toEqual({ ok: false, code: 'not_found' }) // HR без audit.view — не администратор
    // Повторный проход ничего не трогает
    expect(await N.archiveNotesTenant(tenantId)).toBe(0)
  })
})

describe('RLS', () => {
  it('чужой тенант заметок не видит даже прямым запросом внутри своей транзакции', async () => {
    const rows = await withTenant(otherTenantId, null, tx => tx.execute(sql`select count(*)::int as n from user_notes`)) as unknown as { n: number }[]
    expect(rows[0]!.n).toBe(0)
  })
})
