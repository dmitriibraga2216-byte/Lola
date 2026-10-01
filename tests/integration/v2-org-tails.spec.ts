import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Хвосты оргструктуры (`docs/v2/32-org-structure.md` §7 п. 7, §7.8, §8, §11; решения
 * `docs/v2/44-decisions.md` §16 Р-OS.1…Р-OS.5):
 * - `org.daily_snapshot` — 03:00 по поясу тенанта и только при изменениях;
 * - `org.snapshot_cleanup` — 365 дней для всех, ежедневных — не больше тридцати;
 * - писатели `org_node_assigned` и `org_structure_conflict`;
 * - перевод `org_structure_is_source_of_truth` в `true` с подтверждением администратора.
 *
 * Свой тенант, а не «Каппі»: задачи работают по всему тенанту (все снимки, все конфликты,
 * весь штат), и чужие данные общего тенанта сделали бы счётчики неустойчивыми.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { dailySnapshot, snapshotCleanup, notifyStructureConflicts, enableSourceOfTruth, sourceOfTruthStatus, DAILY_SNAPSHOTS_KEPT } = await import('../../server/services/orgJobs')
const { assignUser, createNode } = await import('../../server/services/orgStructure')
const { resolveManager } = await import('../../server/services/orgManager')
const { renderTemplate, DEFAULT_TEMPLATES, emailDefaultEnabled } = await import('../../server/services/notifications')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string
let chief: string, worker: string, pointManager: string
let locationId: string
let positionId: string
let ctx: { tenantId: string, actorId: string }

/** Пояс, в котором сейчас 03:xx: задача снимает только в этот час (`32` §7 п. 7). */
function zoneAtThree(): string {
  const h = new Date().getUTCHours()
  let off = ((3 - h) % 24 + 24) % 24
  if (off > 12) off -= 24
  // `Etc/GMT-5` — это UTC+5: знак в именах зон POSIX обратный.
  return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`
}

async function wipe(tid: string) {
  await admin`delete from notifications where tenant_id = ${tid}`
  await admin`delete from org_node_assignments where tenant_id = ${tid}`
  await admin`delete from org_manager_map where tenant_id = ${tid}`
  await admin`delete from org_conflicts where tenant_id = ${tid}`
  await admin`delete from org_structure_snapshots where tenant_id = ${tid}`
  for (let i = 0; i < 13 && (await admin`select 1 from org_nodes where tenant_id = ${tid} limit 1`).length; i++) {
    await admin`delete from org_nodes where tenant_id = ${tid} and id not in (select parent_id from org_nodes where parent_id is not null and tenant_id = ${tid})`
  }
  await admin`delete from audit_log where tenant_id = ${tid}`
  await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) - 'org_structure_is_source_of_truth' where id = ${tid}`
}

async function person(name: string, phone: string): Promise<string> {
  const [u] = await admin`
    insert into users (tenant_id, full_name, last_name, first_name, phone, status, kind)
    values (${tenantId}, ${name}, ${name}, 'Тест', ${phone}, 'invited', 'employee')
    on conflict do nothing returning id`
  const id = (u?.id ?? (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id) as string
  await admin`delete from user_placements where user_id = ${id}`
  await admin`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary) values (${tenantId}, ${id}, ${locationId}, ${positionId}, true)`
  return id
}

async function node(title: string, over: Record<string, unknown> = {}) {
  const r = await createNode(ctx, { title, ...over } as never)
  if (!r.ok) throw new Error(`узел «${title}» не создан: ${r.code}`)
  return r.node
}

beforeAll(async () => {
  const [t] = await admin`
    insert into tenants (slug, name) values ('test-org-tails', 'Тест хвостів оргструктури')
    on conflict (slug) do update set name = excluded.name returning id`
  tenantId = t!.id as string
  const [o] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = o!.id as string
  await wipe(tenantId)
  const [unit] = await admin`
    insert into org_units (tenant_id, name, path) values (${tenantId}, 'Мережа хвостів', 'tails')
    on conflict (tenant_id, path) do update set name = excluded.name returning id`
  locationId = ((await admin`select id from locations where tenant_id = ${tenantId} and name = 'Точка хвостів'`)[0]?.id
    ?? (await admin`insert into locations (tenant_id, name, org_unit_id) values (${tenantId}, 'Точка хвостів', ${unit!.id}) returning id`)[0]!.id) as string
  positionId = ((await admin`select id from positions where tenant_id = ${tenantId} and name = 'Кухар хвостів'`)[0]?.id
    ?? (await admin`insert into positions (tenant_id, name) values (${tenantId}, 'Кухар хвостів') returning id`)[0]!.id) as string
  adminId = await person('Адмін Хвостів', '+380684310001')
  chief = await person('Шеф Хвостів', '+380684310002')
  worker = await person('Кухар Хвостів', '+380684310003')
  pointManager = await person('Керуючий Точки', '+380684310004')
  // Администратор структуры — носитель `org.structure.import` (`32` §2): адресат письма о конфликтах.
  const [role] = await admin`
    insert into roles (tenant_id, code, name, scopes, default_scope_type)
    values (${tenantId}, 'admin', 'Адміністратор', ${['org.structure.import', 'org.structure.edit']}, 'tenant')
    on conflict (tenant_id, code) do update set scopes = excluded.scopes returning id`
  await admin`
    insert into user_roles (tenant_id, user_id, role_id, scope_type)
    values (${tenantId}, ${adminId}, ${role!.id}, 'tenant') on conflict do nothing`
  await admin`update locations set manager_id = ${pointManager} where id = ${locationId}`
  // Адресаты рассылок — только действующие сотрудники (`ACTIVE_EMPLOYEES_ONLY`).
  await admin`update users set status = 'active' where id = ${adminId}`
  ctx = { tenantId, actorId: adminId }
})

afterAll(async () => {
  await wipe(tenantId)
  // Люди тестового тенанта — тоже прочь: вход идёт по телефону, и чужой файл с тем же номером
  // иначе попал бы в этого человека (префикс `+38068431` больше нигде не занят).
  await admin`update locations set manager_id = null where tenant_id = ${tenantId}`
  await admin`delete from user_roles where tenant_id = ${tenantId}`
  await admin`delete from user_placements where tenant_id = ${tenantId}`
  await admin`delete from users where tenant_id = ${tenantId}`
  await admin.end()
})

// ── org.daily_snapshot ─────────────────────────────────────────────────────────────────

describe('org.daily_snapshot — 03:00 по поясу тенанта и только при изменениях', () => {
  beforeEach(async () => {
    await wipe(tenantId)
    await admin`update tenants set timezone = ${zoneAtThree()} where id = ${tenantId}`
  })

  it('не в свой час — ничего не делает', async () => {
    await admin`update tenants set timezone = ${zoneAtThree() === 'UTC' ? 'Etc/GMT-6' : 'UTC'} where id = ${tenantId}`
    await node('Корінь поза годиною')
    expect(await dailySnapshot(tenantId)).toEqual({ taken: false, reason: 'not_due' })
  })

  it('пустое дерево не снимается', async () => {
    expect(await dailySnapshot(tenantId)).toEqual({ taken: false, reason: 'empty' })
  })

  it('изменения есть — снимок auto_daily; второй раз за местные сутки — нет', async () => {
    await node('Корінь А')
    const r = await dailySnapshot(tenantId)
    expect(r.taken).toBe(true)
    const snaps = await admin`select kind, node_count, created_by from org_structure_snapshots where tenant_id = ${tenantId}`
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({ kind: 'auto_daily', node_count: 1, created_by: null })
    expect(await dailySnapshot(tenantId)).toEqual({ taken: false, reason: 'already_taken' })
  })

  it('со времени прошлого снимка ничего не менялось — снимка нет; изменили — есть', async () => {
    await node('Корінь Б')
    expect((await dailySnapshot(tenantId)).taken).toBe(true)
    // «Вчерашний» снимок: сдвигаем его и журнал на сутки назад.
    await admin`update org_structure_snapshots set created_at = created_at - interval '1 day' where tenant_id = ${tenantId}`
    await admin`update audit_log set created_at = created_at - interval '1 day 1 minute' where tenant_id = ${tenantId}`
    expect(await dailySnapshot(tenantId)).toEqual({ taken: false, reason: 'no_changes' })
    await node('Корінь В')
    const r = await dailySnapshot(tenantId)
    expect(r).toMatchObject({ taken: true, nodeCount: 2 })
  })

  it('снимок руками после изменений — ежедневный уже не нужен', async () => {
    await node('Корінь Г')
    await admin`update audit_log set created_at = created_at - interval '1 minute' where tenant_id = ${tenantId}`
    await admin`
      insert into org_structure_snapshots (tenant_id, label, kind, tree, node_count)
      values (${tenantId}, 'руками', 'manual', '{"nodes":[],"holders":[]}'::jsonb, 1)`
    expect(await dailySnapshot(tenantId)).toEqual({ taken: false, reason: 'no_changes' })
  })

  it('чужой тенант снимком не задет', async () => {
    await node('Корінь Д')
    await dailySnapshot(tenantId)
    const other = await withTenant(otherTenantId, null, tx => tx.execute(sql`select count(*)::int as n from org_structure_snapshots`)) as unknown as { n: number }[]
    expect(other[0]!.n).toBe(0)
  })
})

// ── org.snapshot_cleanup ───────────────────────────────────────────────────────────────

describe('org.snapshot_cleanup — 365 дней и не больше тридцати ежедневных', () => {
  beforeAll(async () => { await wipe(tenantId) })

  it('удаляет старше года и ежедневные сверх тридцати, ручные младше года — оставляет', async () => {
    for (let d = 0; d < DAILY_SNAPSHOTS_KEPT + 5; d++) {
      await admin`
        insert into org_structure_snapshots (tenant_id, label, kind, tree, node_count, created_at)
        values (${tenantId}, ${`day-${d}`}, 'auto_daily', '{"nodes":[],"holders":[]}'::jsonb, 0, now() - make_interval(days => ${d}::int))`
    }
    await admin`
      insert into org_structure_snapshots (tenant_id, label, kind, tree, node_count, created_at) values
        (${tenantId}, 'ручний старий', 'manual', '{"nodes":[],"holders":[]}'::jsonb, 0, now() - interval '400 days'),
        (${tenantId}, 'ручний', 'manual', '{"nodes":[],"holders":[]}'::jsonb, 0, now() - interval '200 days'),
        (${tenantId}, 'перед імпортом', 'pre_import', '{"nodes":[],"holders":[]}'::jsonb, 0, now() - interval '300 days')`

    const r = await snapshotCleanup(tenantId)
    expect(r).toEqual({ expired: 1, dailyOverflow: 5 })
    const left = await admin`select kind, label from org_structure_snapshots where tenant_id = ${tenantId} order by created_at desc`
    expect(left.filter(s => s.kind === 'auto_daily')).toHaveLength(DAILY_SNAPSHOTS_KEPT)
    expect(left.filter(s => s.kind === 'auto_daily').map(s => s.label)).toContain('day-0')
    expect(left.map(s => s.label)).toEqual(expect.arrayContaining(['ручний', 'перед імпортом']))
    expect(left.map(s => s.label)).not.toContain('ручний старий')
    const [audit] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = 'org_structure.snapshot_cleanup'`
    expect(audit!.after).toEqual({ expired: 1, dailyOverflow: 5 })
  })

  it('чистить нечего — журнал не пишется', async () => {
    await admin`delete from audit_log where tenant_id = ${tenantId}`
    expect(await snapshotCleanup(tenantId)).toEqual({ expired: 0, dailyOverflow: 0 })
    expect(await admin`select 1 from audit_log where tenant_id = ${tenantId}`).toHaveLength(0)
  })
})

// ── org_structure_conflict ─────────────────────────────────────────────────────────────

describe('org_structure_conflict — письмо администраторам о новых critical', () => {
  beforeAll(async () => { await wipe(tenantId) })

  const conflict = (severity: string, resolved = false) => admin`
    insert into org_conflicts (tenant_id, kind, severity, source, details, resolved_at)
    values (${tenantId}, 'depth_exceeded', ${severity}, 'manual', '{}'::jsonb, ${resolved ? new Date() : null})`

  it('warning и разобранные не считаются; новые critical — одно письмо носителю org.structure.import', async () => {
    await conflict('warning')
    await conflict('critical', true)
    expect(await notifyStructureConflicts(tenantId)).toEqual({ count: 0, sent: 0 })
    await conflict('critical')
    await conflict('critical')
    expect(await notifyStructureConflicts(tenantId)).toEqual({ count: 2, sent: 1 })
    const [n] = await admin`select user_id, payload from notifications where tenant_id = ${tenantId} and code = 'org_structure_conflict'`
    expect(n).toMatchObject({ user_id: adminId, payload: { count: 2 } })
  })

  it('те же конфликты второй раз не приходят; новый — приходит отдельным письмом', async () => {
    expect(await notifyStructureConflicts(tenantId)).toEqual({ count: 0, sent: 0 })
    await new Promise(r => setTimeout(r, 5))
    await conflict('critical')
    expect(await notifyStructureConflicts(tenantId)).toEqual({ count: 1, sent: 1 })
  })

  it('канал — e-mail (`32` §8)', () => {
    expect(emailDefaultEnabled('org_structure_conflict')).toBe(true)
  })
})

// ── org_node_assigned ──────────────────────────────────────────────────────────────────

describe('org_node_assigned — человеку, которого привязали к узлу', () => {
  beforeAll(async () => {
    await wipe(tenantId)
    await admin`update tenants set settings = coalesce(settings, '{}'::jsonb) || '{"org_structure_is_source_of_truth": true}'::jsonb where id = ${tenantId}`
  })

  it('называет узел и руководителя, org_manager_changed тому же человеку не дублирует', async () => {
    const top = await node('Шеф-кухар', { isManagerPoint: true, headcountPlanned: 1 })
    const cook = await node('Кухар', { parentId: top.id, headcountPlanned: 3 })
    expect((await assignUser(ctx, top.id, { userId: chief })).ok).toBe(true)
    expect((await assignUser(ctx, cook.id, { userId: worker })).ok).toBe(true)

    const mine = await admin`select code, payload from notifications where tenant_id = ${tenantId} and user_id = ${worker} order by created_at`
    expect(mine.map(n => n.code)).toEqual(['org_node_assigned'])
    expect(mine[0]!.payload).toEqual({ node_title: 'Кухар', manager_name: 'Шеф Хвостів' })
    // Руководителю — «у вашій команді новий співробітник», как и раньше.
    const chiefs = await admin`select code from notifications where tenant_id = ${tenantId} and user_id = ${chief} and code = 'org_subordinate_added'`
    expect(chiefs).toHaveLength(1)
  })

  it('без руководителя шаблон не обрывается на «Керівник — .»', () => {
    const tpl = DEFAULT_TEMPLATES.org_node_assigned!
    expect(renderTemplate(tpl, { node_title: 'Кухар', manager_name: '' })).toBe('Вас додано до оргструктури: Кухар.')
    expect(renderTemplate(tpl, { node_title: 'Кухар', manager_name: 'Шеф' })).toBe('Вас додано до оргструктури: Кухар. Керівник — Шеф.')
  })
})

// ── org_structure_is_source_of_truth ───────────────────────────────────────────────────

describe('перевод дерева в источник истины (`32` §7.8)', () => {
  beforeAll(async () => { await wipe(tenantId) })

  it('меньше пяти узлов — не предлагается и не переводится', async () => {
    const root = await node('Керуюча компанія', { isManagerPoint: true, headcountPlanned: 1 })
    await node('Кухня', { parentId: root.id })
    expect(await sourceOfTruthStatus(ctx)).toMatchObject({ enabled: false, liveNodes: 2, eligible: false })
    expect(await enableSourceOfTruth(ctx)).toEqual({ ok: false, code: 'too_few_nodes', liveNodes: 2 })
    expect((await admin`select settings from tenants where id = ${tenantId}`)[0]!.settings.org_structure_is_source_of_truth).toBeUndefined()
  })

  it('пять узлов — предлагается; подтверждение переводит флаг, руководители берутся из дерева', async () => {
    const [root] = await admin`select id from org_nodes where tenant_id = ${tenantId} and parent_id is null`
    const kitchen = (await admin`select id from org_nodes where tenant_id = ${tenantId} and title = 'Кухня'`)[0]!.id as string
    await node('Бар', { parentId: root!.id })
    await node('Зал', { parentId: root!.id })
    await node('Склад', { parentId: root!.id })
    await assignUser(ctx, root!.id as string, { userId: chief })
    await assignUser(ctx, kitchen, { userId: worker })
    await admin`delete from notifications where tenant_id = ${tenantId}`

    // До перевода руководитель кухаря — из поля точки.
    const before = await withTenant(tenantId, null, tx => resolveManager(tx, worker))
    expect(before).toMatchObject({ managerUserId: pointManager, source: 'location' })
    expect(await sourceOfTruthStatus(ctx)).toMatchObject({ enabled: false, liveNodes: 5, eligible: true })

    const r = await enableSourceOfTruth(ctx)
    expect(r).toMatchObject({ ok: true, alreadyEnabled: false })
    expect(r.ok && r.changed).toBeGreaterThanOrEqual(1)

    const after = await withTenant(tenantId, null, tx => resolveManager(tx, worker))
    expect(after).toMatchObject({ managerUserId: chief, source: 'org_tree' })
    const [map] = await admin`select manager_user_id, source from org_manager_map where tenant_id = ${tenantId} and user_id = ${worker}`
    expect(map).toMatchObject({ manager_user_id: chief, source: 'org_tree' })
    const changed = await admin`select payload from notifications where tenant_id = ${tenantId} and user_id = ${worker} and code = 'org_manager_changed'`
    expect(changed).toHaveLength(1)
    expect(changed[0]!.payload).toEqual({ manager_name: 'Шеф Хвостів' })
    const [audit] = await admin`select actor_id, after from audit_log where tenant_id = ${tenantId} and action = 'org_structure.source_of_truth'`
    expect(audit).toMatchObject({ actor_id: adminId, after: { enabled: true, liveNodes: 5 } })
    expect(await sourceOfTruthStatus(ctx)).toMatchObject({ enabled: true, eligible: false })
  })

  it('повторный перевод — без изменений и без второй записи журнала', async () => {
    expect(await enableSourceOfTruth(ctx)).toEqual({ ok: true, alreadyEnabled: true, changed: 0 })
    expect(await admin`select 1 from audit_log where tenant_id = ${tenantId} and action = 'org_structure.source_of_truth'`).toHaveLength(1)
  })
})
