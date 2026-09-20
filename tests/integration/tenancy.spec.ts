import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 25 — критерии приёмки мультитенантности docs/25 §14, п. 1–10 (нумерация и названия — как в документе),
 * плюс round-robin и лимит активных задач (§5, §10), suspended → отказ (§8), purge → данные удалены (§8),
 * резолв тенанта по Host (§16.1; HTTP с заголовком Host) и `platform_audit` (§7 п. 5).
 * Сервисные проверки идут всегда; HTTP-часть — по собранному приложению (`pnpm build`), как в spec24-http.
 */
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { withTenant } = await import('../../server/utils/withTenant')
const { db } = await import('../../server/db/client')
const { createTenant, platformLogin, validatePlatformSession, ensureFirstAdmin, listTenants, checkPlanLimit } = await import('../../server/services/platform')
const { suspendTenant, resumeTenant, schedulePurge, cancelPurge, setTenantLimits, getTenantLimits, runTenantPurge, listPlatformAudit, purgeAtOf } = await import('../../server/services/platformTenants')
const { roundRobinOrder, runPerTenant, withTenantSlot, activeJobsOf, resetRoundRobin } = await import('../../server/services/tenantQueue')
const { decideHost, resolveTenantByHost, invalidateTenant, tenantById } = await import('../../server/services/tenantResolve')
const { effectiveLimits, invalidateLimits, DEFAULT_ACTIVE_JOBS } = await import('../../server/services/tenantLimits')
const { dispatchNotifications } = await import('../../server/services/notifications')
const { createSession } = await import('../../server/services/session')
const { getMedia } = await import('../../server/services/media')
const { tags } = await import('../../server/db/schema')

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3797
const BASE = `http://127.0.0.1:${PORT}`
const HOST_BASE = 'lola.test'
const ADMIN_PHONE = '+380661864742'
const OPS_EMAIL = 'ops-tenancy@lola.local'
const OPS_PASSWORD = 'test-password-123'

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const app = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })

let kappiId: string
let tenantA: { id: string, slug: string, adminUserId: string }
let tenantB: { id: string, slug: string, adminUserId: string }
let opsAuth: { adminId: string, email: string, fullName: string }
let tenantTables: string[] = []
const stamp = Date.now().toString(36)

async function tablesWithTenantId(): Promise<string[]> {
  const rows = await admin`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname`
  return rows.map(r => r.t as string)
}
/** Та же проверка, что в rls.spec.ts: таблицы с tenant_id без включённого, принудительного RLS с политикой. */
async function rlsGaps(): Promise<string[]> {
  const rows = await admin`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      and not (c.relrowsecurity and c.relforcerowsecurity and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname))`
  return rows.map(r => r.t as string)
}
const rowsOf = async (tenantId: string) => {
  const out: Record<string, number> = {}
  for (const t of tenantTables) {
    const [r] = await admin<[{ n: number }]>`select count(*)::int as n from ${admin(t)} where tenant_id = ${tenantId}`
    if (r!.n) out[t] = r!.n
  }
  return out
}

beforeAll(async () => {
  kappiId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  opsAuth = (await validatePlatformSession((await platformLogin(OPS_EMAIL, OPS_PASSWORD))!.token))!
  const a = await createTenant({ slug: `ta-${stamp}`, name: 'Тенант А', adminPhone: '+380501000001', adminName: 'Адмін А', plan: 'network' }, opsAuth)
  const b = await createTenant({ slug: `tb-${stamp}`, name: 'Тенант Б', adminPhone: '+380501000002', adminName: 'Адмін Б', plan: 'network' }, opsAuth)
  if (!a.ok || !b.ok) throw new Error('не удалось создать тестовые тенанты')
  tenantA = { id: a.tenantId, slug: `ta-${stamp}`, adminUserId: a.adminUserId }
  tenantB = { id: b.tenantId, slug: `tb-${stamp}`, adminUserId: b.adminUserId }
  await admin`update users set status = 'active' where id in (${tenantA.adminUserId}, ${tenantB.adminUserId})`
  tenantTables = await tablesWithTenantId()
}, 60_000)

afterAll(async () => {
  // Что не удалено purge-тестом — вычищаем тем же сервисом (он и есть полный список таблиц)
  for (const t of [tenantA, tenantB]) {
    const [row] = await admin`select id from tenants where id = ${t.id}`
    if (row) {
      const { purgeTenantData } = await import('../../server/services/platformTenants')
      await purgeTenantData(t.id, opsAuth)
    }
  }
  await admin`delete from platform_audit where admin_email = ${OPS_EMAIL} or (admin_email = 'worker' and after->>'slug' like ${`t_-${stamp}`})`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin`delete from otp_codes where phone in ('+380501000001', '+380501000002')`
  await admin.end()
  await app.end()
})

describe('docs/25 §14 — критерии приёмки', () => {
  it('1. Дано две тенанта с данными, коли запрос под тенантом А по каждой таблице, тоді ни одна строка тенанта Б не возвращается', async () => {
    const withData = await rowsOf(kappiId)
    expect(Object.keys(withData).length).toBeGreaterThanOrEqual(5)
    await withTenant(tenantA.id, tenantA.adminUserId, async (tx) => {
      for (const t of Object.keys(withData)) {
        const rows = await tx.execute(`select count(*)::int as n from "${t}" where tenant_id = '${kappiId}'`) as unknown as { n: number }[]
        expect(rows[0]!.n, `утечка ${t}`).toBe(0)
      }
    })
  })

  it('2. Дано новая таблица с tenant_id без политики, тоді тест rls.spec.ts падает с именем таблицы', async () => {
    const probe = `zz_tenancy_probe_${stamp}`
    await admin.unsafe(`create table ${probe} (id serial primary key, tenant_id uuid not null)`)
    try {
      expect(await rlsGaps()).toContain(probe)
    }
    finally {
      await admin.unsafe(`drop table ${probe}`)
    }
    expect(await rlsGaps()).toEqual([]) // текущая схема без дыр, включая новую tenant_limits
  })

  it('3. Дано попытка вставки строки с чужим tenant_id внутри withTenant, тоді ошибка БД', async () => {
    await expect(withTenant(tenantA.id, tenantA.adminUserId, tx =>
      tx.insert(tags).values({ tenantId: kappiId, name: `leak-${stamp}`, scope: 'user' }),
    )).rejects.toThrow(/row-level security/)
  })

  it('5. Дано соединение из пула после тенанта А, коли следующий запрос от тенанта Б, тоді current_setting = Б (set без local не утекает)', async () => {
    const setting = (rows: unknown) => (rows as { t: string | null }[])[0]!.t
    await withTenant(tenantA.id, null, async tx => expect(setting(await tx.execute(`select current_setting('app.tenant_id', true) as t`))).toBe(tenantA.id))
    await withTenant(tenantB.id, null, async tx => expect(setting(await tx.execute(`select current_setting('app.tenant_id', true) as t`))).toBe(tenantB.id))
    // Вне транзакции на этом же пуле контекста нет: set_config(…, true) живёт только в транзакции
    const outside = await db.execute(`select coalesce(current_setting('app.tenant_id', true), '') as t`) as unknown as { t: string }[]
    expect(outside[0]!.t).toBe('')
    // Одно соединение (max: 1): после транзакции А следующий запрос без контекста ничего не видит
    await app.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${tenantA.id}, true)`; await tx`select count(*) from users` })
    const [{ t }] = await app<[{ t: string }]>`select coalesce(current_setting('app.tenant_id', true), '') as t`
    expect(t).toBe('')
    const [{ n }] = await app<[{ n: number }]>`select count(*)::int as n from users`
    expect(n).toBe(0)
  })

  it('6. Дано файл тенанта А, коли пользователь тенанта Б запрашивает его по прямому ключу, тоді 404 (сервис отдаёт null)', async () => {
    const [m] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, uploaded_by) values (${tenantA.id}, ${`t/${tenantA.id}/tenancy-${stamp}.png`}, 'a.png', 'image', 'image/png', 10, 'ready', ${tenantA.adminUserId}) returning id`
    expect(await getMedia({ tenantId: tenantA.id, actorId: tenantA.adminUserId }, m!.id as string)).not.toBeNull()
    expect(await getMedia({ tenantId: tenantB.id, actorId: tenantB.adminUserId }, m!.id as string)).toBeNull()
  })

  it('7. Дано фоновая задача упала на тенанте А, тоді задачи остальных тенантов выполнились', async () => {
    resetRoundRobin()
    const ran: string[] = []
    const s = await runPerTenant('test.fail', async (tenantId) => {
      if (tenantId === tenantA.id) throw new Error('boom')
      ran.push(tenantId)
    }, [tenantA.id, tenantB.id, kappiId])
    expect(ran.sort()).toEqual([tenantB.id, kappiId].sort())
    expect(s.failed).toBe(1)
    expect(s.done).toBe(2)
    expect(s.errors[tenantA.id]).toBe('boom')
  })

  it('8. Дано 5000 уведомлений у тенанта А и 5 у тенанта Б, тоді уведомления Б уходят за первый круг, а не после очереди А', async () => {
    resetRoundRobin()
    invalidateLimits()
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for)
      select ${tenantA.id}, ${tenantA.adminUserId}, 'manual', 'inapp', '{"text":"a"}', 'queued', now() - interval '1 minute' from generate_series(1, 5000)`
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for)
      select ${tenantB.id}, ${tenantB.adminUserId}, 'manual', 'inapp', '{"text":"b"}', 'queued', now() - interval '1 minute' from generate_series(1, 5)`
    const queued = async (id: string) => (await admin<[{ n: number }]>`select count(*)::int as n from notifications where tenant_id = ${id} and status = 'queued'`)[0]!.n
    const started = Date.now()
    const round = await runPerTenant('notification.dispatch', (tenantId, quota) => dispatchNotifications(tenantId, quota), [tenantA.id, tenantB.id])
    expect(round.done).toBe(2)
    expect(await queued(tenantB.id)).toBe(0) // Б обслужен в первом же круге
    expect(await queued(tenantA.id)).toBe(5000 - DEFAULT_ACTIVE_JOBS) // А получил ровно квоту
    expect(Date.now() - started).toBeLessThan(60_000)
    await admin`delete from notifications where tenant_id in (${tenantA.id}, ${tenantB.id})`
  })

  it('9. Дано оператор открыл панель платформы, тоді он видит агрегаты и не видит ни одной персональной строки', async () => {
    const rows = await listTenants()
    const a = rows.find(r => r.id === tenantA.id)!
    expect(a).toBeDefined()
    expect(Object.keys(a)).toEqual(expect.arrayContaining(['active_users', 'total_users', 'media_bytes', 'users_limit', 'status', 'archived_at']))
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/\+380|full_name|phone|email/)
  })

  it('10. Дано тенант приостановлен, тоді вход закрыт, фоновые задачи по нему не идут, уведомления не отправляются, данные целы', async () => {
    // долг «28» Spec 25 отк. (3): медиа, застрявшее в processing на момент приостановки, ставится
    // заново в media.process при resume (сама задача не переставляется, пока тенант suspended)
    const [stuckMedia] = await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status) values (${tenantA.id}, ${`t/${tenantA.id}/stuck-${stamp}.jpg`}, 'stuck.jpg', 'image', 'image/jpeg', 10, 'processing') returning id`
    const before = await rowsOf(tenantA.id)
    const r = await suspendTenant(tenantA.id, 'тест приостановки', opsAuth)
    expect(r.ok && r.status).toBe('suspended')
    expect((await tenantById(tenantA.id))!.status).toBe('suspended')
    // вход закрыт — сессия не создаётся ни по коду, ни по паролю, ни «от имени» (все идут через createSession)
    await expect(createSession({ tenantId: tenantA.id, userId: tenantA.adminUserId })).rejects.toMatchObject({ statusCode: 403, data: { code: 'tenant_suspended' } })
    // задачи не идут
    resetRoundRobin()
    const ran: string[] = []
    const s = await runPerTenant('test.suspended', async (id) => { ran.push(id) }, [tenantA.id, tenantB.id])
    expect(ran).toEqual([tenantB.id])
    expect(s.skipped).toBe(1)
    // уведомления не отправляются: очередь А не трогается
    await admin`insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for) values (${tenantA.id}, ${tenantA.adminUserId}, 'manual', 'inapp', '{"text":"a"}', 'queued', now() - interval '1 minute')`
    await runPerTenant('notification.dispatch', (id, quota) => dispatchNotifications(id, quota), [tenantA.id])
    expect((await admin<[{ n: number }]>`select count(*)::int as n from notifications where tenant_id = ${tenantA.id} and status = 'queued'`)[0]!.n).toBe(1)
    await admin`delete from notifications where tenant_id = ${tenantA.id}`
    // данные целы
    expect(await rowsOf(tenantA.id)).toEqual(before)
    // журнал платформы
    const audit = await listPlatformAudit({ tenantId: tenantA.id })
    expect(audit.find(x => x.action === 'tenant.suspend')?.after).toMatchObject({ status: 'suspended', reason: 'тест приостановки' })
    // возобновление — вход снова открыт
    const back = await resumeTenant(tenantA.id, opsAuth)
    expect(back.ok && back.status).toBe('active')
    const sess = await createSession({ tenantId: tenantA.id, userId: tenantA.adminUserId })
    expect(sess.token).toBeTruthy()
    // resume переставил media.process для застрявшего в processing медиа (журнал — requeuedMedia в after)
    const resumeAudit = await listPlatformAudit({ tenantId: tenantA.id })
    expect(resumeAudit.find(x => x.action === 'tenant.resume')?.after).toMatchObject({ requeuedMedia: 1 })
    const job = await admin`select 1 from pgboss.job where name = 'media.process' and data->>'mediaId' = ${stuckMedia!.id}`
    expect(job.length).toBe(1)
    // повторный resume — не тот статус
    expect(await resumeTenant(tenantA.id, opsAuth)).toEqual({ ok: false, code: 'wrong_status' })
  })
})

describe('docs/25 §5, §10 — round-robin и лимит активных задач', () => {
  it('круг начинается с тенанта после обслуженного в прошлый раз; исчезнувший из списка — со следующего по порядку', () => {
    resetRoundRobin()
    expect(roundRobinOrder('q', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(roundRobinOrder('q', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']) // последний был c → снова с a
    expect(roundRobinOrder('q', ['a', 'b'])).toEqual(['a', 'b'])
    resetRoundRobin()
    roundRobinOrder('q', ['a'])
    expect(roundRobinOrder('q', ['a', 'b', 'c'])).toEqual(['b', 'c', 'a'])
    expect(roundRobinOrder('q', ['b', 'c', 'd'])).toEqual(['b', 'c', 'd']) // a пропал: следующий после a — b
    expect(roundRobinOrder('q2', ['x', 'y'])).toEqual(['x', 'y']) // курсоры — по очереди
    expect(roundRobinOrder('q', [])).toEqual([])
  })

  it('tenant_limits переопределяет тариф, null возвращает к тарифу; active_jobs по умолчанию — DEFAULT_ACTIVE_JOBS', async () => {
    invalidateLimits()
    const base = await effectiveLimits(tenantA.id)
    expect(base.users).toBe(1000) // network
    expect(base.activeJobs).toBe(DEFAULT_ACTIVE_JOBS)
    expect(base.overridden).toEqual([])
    const set = await setTenantLimits(tenantA.id, { users: 7, activeJobs: 2 }, opsAuth)
    expect(set!.overrides).toMatchObject({ users: 7, activeJobs: 2, storageGb: null })
    const eff = await effectiveLimits(tenantA.id)
    expect(eff.users).toBe(7)
    expect(eff.activeJobs).toBe(2)
    expect(eff.overridden).toEqual(['users', 'activeJobs'])
    // лимит людей считается по активным (docs/25 §10 п. 1), переопределение видно в проверке
    const lim = await checkPlanLimit(tenantA.id, 'users')
    expect(lim.limit).toBe(7)
    expect(lim.current).toBe(1)
    const audit = await listPlatformAudit({ tenantId: tenantA.id })
    expect(audit.find(x => x.action === 'tenant.limits')?.after).toMatchObject({ users: 7, activeJobs: 2 })
    const cleared = await setTenantLimits(tenantA.id, { users: null, activeJobs: null }, opsAuth)
    expect(cleared!.overrides.users).toBeNull()
    expect((await admin`select id from tenant_limits where tenant_id = ${tenantA.id}`).length).toBe(0)
    expect((await getTenantLimits(tenantA.id))!.plan.users).toBe(1000)
  })

  it('лимит активных задач: сверх active_jobs задача ждёт слот, а не падает', async () => {
    await setTenantLimits(tenantA.id, { activeJobs: 2 }, opsAuth)
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const j1 = withTenantSlot(tenantA.id, async () => { log.push('j1:start'); await gate; log.push('j1:end') })
    const j2 = withTenantSlot(tenantA.id, async () => { log.push('j2:start'); await gate; log.push('j2:end') })
    await new Promise(r => setTimeout(r, 20))
    const j3 = withTenantSlot(tenantA.id, async () => { log.push('j3:start') })
    await new Promise(r => setTimeout(r, 120))
    expect(activeJobsOf(tenantA.id)).toBe(2)
    expect([...log].sort()).toEqual(['j1:start', 'j2:start']) // третья ждёт; порядок первых двух не гарантирован (обе читают лимит из БД)
    release()
    await Promise.all([j1, j2, j3])
    expect(log.slice(-1)).toEqual(['j3:start'])
    expect(activeJobsOf(tenantA.id)).toBe(0)
    await setTenantLimits(tenantA.id, { activeJobs: null }, opsAuth)
  })

  it('tenant_limits изолирована RLS: из чужого тенанта не видна', async () => {
    await setTenantLimits(tenantA.id, { webhooks: 3 }, opsAuth)
    const seen = await withTenant(tenantB.id, null, tx => tx.execute(`select count(*)::int as n from tenant_limits where tenant_id = '${tenantA.id}'`)) as unknown as { n: number }[]
    expect(seen[0]!.n).toBe(0)
    await setTenantLimits(tenantA.id, { webhooks: null }, opsAuth)
  })
})

describe('docs/25 §16.1 — резолв тенанта по Host', () => {
  const cfg = { base: HOST_BASE, defaultHosts: [`lms.${HOST_BASE}`], defaultSlug: 'kappi' }

  it('decideHost: slug-поддомен, дефолтный хост, база, localhost, чужой домен; без TENANT_HOST_BASE — выключен', () => {
    expect(decideHost(`kappi.${HOST_BASE}`, cfg)).toEqual({ kind: 'slug', slug: 'kappi' })
    expect(decideHost(`KAPPI.${HOST_BASE}:3000`, cfg)).toEqual({ kind: 'slug', slug: 'kappi' })
    expect(decideHost(`lms.${HOST_BASE}`, cfg)).toEqual({ kind: 'default' })
    expect(decideHost(HOST_BASE, cfg)).toEqual({ kind: 'default' })
    expect(decideHost('localhost:3000', cfg)).toEqual({ kind: 'default' })
    expect(decideHost('127.0.0.1', cfg)).toEqual({ kind: 'default' })
    expect(decideHost('other.example', cfg)).toEqual({ kind: 'default' })
    expect(decideHost(undefined, cfg)).toEqual({ kind: 'default' })
    expect(decideHost(`a.b.${HOST_BASE}`, cfg)).toEqual({ kind: 'slug', slug: 'a.b' }) // не slug → resolve даст 404
    expect(decideHost(`kappi.${HOST_BASE}`, { base: null, defaultHosts: [], defaultSlug: 'kappi' })).toEqual({ kind: 'off' })
  })

  it('resolveTenantByHost: известный slug → тенант, неизвестный → 404 (tenant null), дефолт → NUXT_PUBLIC_DEFAULT_TENANT', async () => {
    invalidateTenant()
    expect((await resolveTenantByHost(`${tenantA.slug}.${HOST_BASE}`, cfg))?.tenant?.id).toBe(tenantA.id)
    expect((await resolveTenantByHost(`nope-${stamp}.${HOST_BASE}`, cfg))?.tenant).toBeNull()
    expect((await resolveTenantByHost(`a.b.${HOST_BASE}`, cfg))?.tenant).toBeNull()
    expect((await resolveTenantByHost(`lms.${HOST_BASE}`, cfg))?.tenant?.slug).toBe('kappi')
    expect((await resolveTenantByHost('localhost', cfg))?.tenant?.slug).toBe('kappi')
    expect(await resolveTenantByHost('localhost', { ...cfg, base: null })).toBeNull()
    expect((await resolveTenantByHost('localhost', { ...cfg, defaultSlug: null }))?.tenant).toBeNull()
  })
})

describe('docs/25 §8 — purge через 30 дней с подтверждением', () => {
  it('purge только из suspended и только с точным slug; отмена возвращает в suspended; срок — archived_at + 30 дней', async () => {
    expect(await schedulePurge(tenantB.id, tenantB.slug, opsAuth)).toEqual({ ok: false, code: 'wrong_status' }) // активный
    await suspendTenant(tenantB.id, null, opsAuth)
    expect(await schedulePurge(tenantB.id, 'wrong-slug', opsAuth)).toEqual({ ok: false, code: 'confirm_mismatch' })
    const r = await schedulePurge(tenantB.id, tenantB.slug, opsAuth)
    expect(r.ok && r.status).toBe('archived')
    if (!r.ok) return
    expect(new Date(r.purgeAt!).getTime() - new Date(r.archivedAt!).getTime()).toBe(30 * 86_400_000)
    expect(purgeAtOf(new Date(r.archivedAt!))!.toISOString()).toBe(r.purgeAt)
    // в archived вход тоже закрыт
    await expect(createSession({ tenantId: tenantB.id, userId: tenantB.adminUserId })).rejects.toMatchObject({ data: { code: 'tenant_suspended' } })
    // рано — задача не удаляет
    expect(await runTenantPurge(tenantB.id)).toEqual({ purged: false, reason: 'too_early' })
    // отмена
    const c = await cancelPurge(tenantB.id, opsAuth)
    expect(c.ok && c.status).toBe('suspended')
    expect(await runTenantPurge(tenantB.id)).toEqual({ purged: false, reason: 'not_archived' })
    const audit = await listPlatformAudit({ tenantId: tenantB.id })
    expect(audit.map(x => x.action)).toEqual(expect.arrayContaining(['tenant.suspend', 'tenant.purge_schedule', 'tenant.purge_cancel']))
    expect(audit.find(x => x.action === 'tenant.purge_schedule')?.after).toMatchObject({ slug: tenantB.slug })
  })

  it('по сроку задача удаляет все строки тенанта во всех таблицах, строку tenants и пишет отчёт в platform_audit', async () => {
    await schedulePurge(tenantB.id, tenantB.slug, opsAuth)
    await admin`update tenants set archived_at = now() - interval '31 days' where id = ${tenantB.id}`
    // немного данных в разных таблицах
    await withTenant(tenantB.id, tenantB.adminUserId, tx => tx.insert(tags).values({ tenantId: tenantB.id, name: `purge-${stamp}`, scope: 'user' }))
    await admin`insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, uploaded_by) values (${tenantB.id}, ${`t/${tenantB.id}/purge-${stamp}.png`}, 'b.png', 'image', 'image/png', 10, 'ready', ${tenantB.adminUserId})`
    const before = await rowsOf(tenantB.id)
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['users', 'roles', 'locations', 'tags', 'media_assets', 'audit_log']))

    const r = await runTenantPurge(tenantB.id)
    expect(r.purged).toBe(true)
    expect(r.report!.tables.users).toBe(before.users)
    expect(r.report!.tables.tags).toBe(1)
    expect(await rowsOf(tenantB.id)).toEqual({})
    expect((await admin`select id from tenants where id = ${tenantB.id}`).length).toBe(0)
    expect(await tenantById(tenantB.id)).toBeNull()
    const [aud] = await admin`select * from platform_audit where action = 'tenant.purged' and entity_id = ${tenantB.id}`
    expect(aud).toBeDefined()
    expect(aud!.subject_tenant_id).toBeNull() // FK set null — запись пережила тенанта
    expect((aud!.before as { slug: string }).slug).toBe(tenantB.slug)
    expect((aud!.after as { tables: Record<string, number> }).tables.users).toBe(before.users)
    // повтор — идемпотентно
    expect(await runTenantPurge(tenantB.id)).toEqual({ purged: false, reason: 'not_found' })
  })
})

// ── HTTP: тенант из тела игнорируется (п. 4), чужой файл — 404 (п. 6), Host, suspended по API, platform_audit ──

/** fetch не даёт задать заголовок Host (forbidden header) — для проверок резолва по хосту идём через node:http. */
function hfetch(url: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : [v]) if (x) headers.append(k, x)
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }))
      })
    })
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}

describe.skipIf(!BUILT)('docs/25 по HTTP (собранное приложение, Host-резолв включён)', () => {
  let server: ChildProcess | undefined
  const HOST_KAPPI = `kappi.${HOST_BASE}`

  async function login(phone: string, host = HOST_KAPPI): Promise<string> {
    await admin`delete from rate_limits where key like ${'otp:%'}`
    await admin`delete from otp_codes where phone = ${phone}`
    const h = { 'Content-Type': 'application/json', 'Host': host }
    const req = await hfetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: h, body: JSON.stringify({ phone }) })
    const body = await req.json() as { data: { devCode?: string } }
    if (!body.data?.devCode) throw new Error(`Нет devCode для ${phone}: ${JSON.stringify(body)}`)
    const ver = await hfetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: h, body: JSON.stringify({ phone, code: body.data.devCode }) })
    if (!ver.ok) throw new Error(`verify ${phone} → ${ver.status} ${await ver.text()}`)
    return ver.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }
  const csrfOf = (cookie: string) => cookie.split('; ').find(c => c.startsWith('lola_csrf='))?.split('=')[1] ?? ''
  const json = (cookie: string, method: string, body?: unknown, host = HOST_KAPPI) => ({ method, headers: { 'cookie': cookie, 'x-csrf-token': csrfOf(cookie), 'Content-Type': 'application/json', 'Host': host }, body: body === undefined ? undefined : JSON.stringify(body) })
  const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code
  let opsCookie = ''

  beforeAll(async () => {
    await admin`delete from rate_limits where key like ${'otp:%'} or key like ${'ops:%'}`
    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), OTP_DEBUG: '1', NUXT_DATABASE_URL: process.env.DATABASE_URL, PLATFORM_ADMIN_EMAIL: OPS_EMAIL, PLATFORM_ADMIN_PASSWORD: OPS_PASSWORD, TENANT_HOST_BASE: HOST_BASE, TENANT_HOST_DEFAULT: `lms.${HOST_BASE}`, NUXT_PUBLIC_DEFAULT_TENANT: 'kappi', WORKER_ENABLED: '0' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try { if ((await hfetch(`${BASE}/health`)).ok) break }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    const opsLogin = await hfetch(`${BASE}/api/v1/platform/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OPS_EMAIL, password: OPS_PASSWORD }) })
    if (!opsLogin.ok) throw new Error(`ops login → ${opsLogin.status}`)
    opsCookie = opsLogin.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  }, 90_000)

  afterAll(async () => {
    server?.kill()
    await admin`delete from tags where tenant_id = ${kappiId} and name like ${`http-${stamp}%`}`
    await admin`delete from rate_limits where key like ${'otp:%'} or key like ${'ops:%'}`
  })

  it('Host: неизвестный поддомен — 404 без страницы входа; дефолтный хост и localhost — тенант по умолчанию; slug-хост — свой тенант', async () => {
    expect((await hfetch(`${BASE}/api/v1/public/guest-page`, { headers: { Host: `nope-${stamp}.${HOST_BASE}` } })).status).toBe(404)
    expect((await hfetch(`${BASE}/login`, { headers: { Host: `nope-${stamp}.${HOST_BASE}` } })).status).toBe(404)
    const viaDefault = await hfetch(`${BASE}/api/v1/public/guest-page`, { headers: { Host: `lms.${HOST_BASE}` } })
    expect(viaDefault.status).toBe(200)
    expect(((await viaDefault.json()) as { data: { slug: string } }).data.slug).toBe('kappi')
    const viaLocal = await hfetch(`${BASE}/api/v1/public/guest-page`, { headers: { Host: '127.0.0.1' } })
    expect(((await viaLocal.json()) as { data: { slug: string } }).data.slug).toBe('kappi')
    const viaSlug = await hfetch(`${BASE}/api/v1/public/guest-page`, { headers: { Host: `${tenantA.slug}.${HOST_BASE}` } })
    expect(((await viaSlug.json()) as { data: { slug: string } }).data.slug).toBe(tenantA.slug)
    // служебное и платформа — вне резолва
    expect((await hfetch(`${BASE}/health`, { headers: { Host: `nope.${HOST_BASE}` } })).status).toBe(200)
    expect((await hfetch(`${BASE}/api/v1/platform/me`, { headers: { Host: `nope.${HOST_BASE}`, cookie: opsCookie } })).status).toBe(200)
  })

  it('сессия и Host должны совпадать: cookie «Каппі» на хосте тенанта А — как без сессии (401); на своём хосте — работает', async () => {
    const cookie = await login(ADMIN_PHONE)
    expect((await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie, Host: HOST_KAPPI } })).status).toBe(200)
    expect((await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie, Host: `lms.${HOST_BASE}` } })).status).toBe(200) // дефолтный хост = kappi
    expect((await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie, Host: `${tenantA.slug}.${HOST_BASE}` } })).status).toBe(401)
    // вход на хосте тенанта А номером из «Каппі» — номера там нет: код верный, но 401 без раскрытия
    await admin`delete from otp_codes where phone = ${ADMIN_PHONE}`
    const h = { 'Content-Type': 'application/json', 'Host': `${tenantA.slug}.${HOST_BASE}` }
    const req = await hfetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: h, body: JSON.stringify({ phone: ADMIN_PHONE }) })
    const code = ((await req.json()) as { data: { devCode?: string } }).data?.devCode
    if (code) {
      const ver = await hfetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: h, body: JSON.stringify({ phone: ADMIN_PHONE, code }) })
      expect(ver.status).toBe(401)
    }
  })

  it('4. Дано запрос с параметром tenantId чужого тенанта в теле, тоді параметр игнорируется, данные — из сессии', async () => {
    const cookie = await login(ADMIN_PHONE)
    const res = await hfetch(`${BASE}/api/v1/tags`, json(cookie, 'POST', { name: `http-${stamp}`, scope: 'user', tenantId: tenantA.id, tenant_id: tenantA.id }))
    expect(res.status).toBe(200)
    const created = ((await res.json()) as { data: { id: string } }).data
    const [row] = await admin`select tenant_id from tags where id = ${created.id}`
    expect(row!.tenant_id).toBe(kappiId)
  })

  it('6. чужой файл по прямому ключу — 404, не 403', async () => {
    const cookie = await login(ADMIN_PHONE)
    const [m] = await admin`select id from media_assets where tenant_id = ${tenantA.id} and key like ${`t/${tenantA.id}/tenancy-%`} limit 1`
    const res = await hfetch(`${BASE}/api/v1/media/${m!.id}`, { headers: { cookie, Host: HOST_KAPPI } })
    expect(res.status).toBe(404)
    expect(await errCode(res)).toBe('not_found')
  })

  it('10. suspended через панель: API отвечает 403 tenant_suspended, вход закрыт, выйти можно; resume возвращает доступ; platform_audit пишется', async () => {
    const cookie = await login(ADMIN_PHONE)
    expect((await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie, Host: HOST_KAPPI } })).status).toBe(200)
    const susp = await hfetch(`${BASE}/api/v1/platform/tenants/${kappiId}/suspend`, { method: 'POST', headers: { 'cookie': opsCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'http-тест' }) })
    expect(susp.status).toBe(200)
    try {
      const me = await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie, Host: HOST_KAPPI } })
      expect(me.status).toBe(403)
      expect(await errCode(me)).toBe('tenant_suspended')
      // выйти из закрытого пространства можно
      expect((await hfetch(`${BASE}/api/v1/auth/logout`, json(cookie, 'POST'))).status).toBe(200)
      // вход по коду закрыт
      await admin`delete from rate_limits where key like ${'otp:%'}`
      await admin`delete from otp_codes where phone = ${ADMIN_PHONE}`
      const h = { 'Content-Type': 'application/json', 'Host': HOST_KAPPI }
      const req = await hfetch(`${BASE}/api/v1/auth/otp/request`, { method: 'POST', headers: h, body: JSON.stringify({ phone: ADMIN_PHONE }) })
      expect(req.status).toBe(403) // код не шлём, а объясняем
      expect(await errCode(req)).toBe('tenant_suspended')
      const ver = await hfetch(`${BASE}/api/v1/auth/otp/verify`, { method: 'POST', headers: h, body: JSON.stringify({ phone: ADMIN_PHONE, code: '000000' }) })
      expect([401, 403]).toContain(ver.status)
      // список тенантов показывает статус
      const list = await hfetch(`${BASE}/api/v1/platform/tenants`, { headers: { cookie: opsCookie } })
      expect(((await list.json()) as { data: { id: string, status: string }[] }).data.find(t => t.id === kappiId)!.status).toBe('suspended')
      // повторная приостановка — 409
      expect((await hfetch(`${BASE}/api/v1/platform/tenants/${kappiId}/suspend`, { method: 'POST', headers: { 'cookie': opsCookie, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(409)
    }
    finally {
      const res = await hfetch(`${BASE}/api/v1/platform/tenants/${kappiId}/resume`, { method: 'POST', headers: { cookie: opsCookie } })
      expect(res.status).toBe(200)
    }
    invalidateTenant(kappiId)
    const again = await login(ADMIN_PHONE)
    expect((await hfetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: again, Host: HOST_KAPPI } })).status).toBe(200)
    // platform_audit: и действия, и сами запросы панели (docs/25 §7 п. 5), с request_context
    const audit = await hfetch(`${BASE}/api/v1/platform/audit?tenantId=${kappiId}&limit=50`, { headers: { cookie: opsCookie } })
    const rows = ((await audit.json()) as { data: { action: string, adminEmail: string, requestContext: { ip: string | null } | null, after: unknown }[] }).data
    expect(rows.find(r => r.action === 'tenant.suspend')?.after).toMatchObject({ reason: 'http-тест' })
    expect(rows.find(r => r.action === 'tenant.resume')?.adminEmail).toBe(OPS_EMAIL)
    expect(rows.find(r => r.action === 'platform.request')).toBeDefined()
    expect(rows.find(r => r.action === 'tenant.suspend')?.requestContext?.ip).toBeTruthy()
    // список тенантов через API — без персональных строк (п. 9)
    const list = await hfetch(`${BASE}/api/v1/platform/tenants`, { headers: { cookie: opsCookie } })
    expect(await list.text()).not.toMatch(/\+380/)
  })

  it('долг «28» Spec 25 отк. (5): platform.request не пишется на список тенантов, но пишется на просмотр карточки конкретного тенанта', async () => {
    const before = await (await hfetch(`${BASE}/api/v1/platform/audit?tenantId=${kappiId}&limit=200`, { headers: { cookie: opsCookie } })).json() as { data: { id: string }[] }
    const seenIds = new Set(before.data.map(r => r.id))
    // список — не карточка конкретного тенанта, GET, не должен писаться
    expect((await hfetch(`${BASE}/api/v1/platform/tenants`, { headers: { cookie: opsCookie } })).status).toBe(200)
    // просмотр карточки — лимиты конкретного тенанта, GET, должен писаться
    expect((await hfetch(`${BASE}/api/v1/platform/tenants/${kappiId}/limits`, { headers: { cookie: opsCookie } })).status).toBe(200)
    const after = await (await hfetch(`${BASE}/api/v1/platform/audit?tenantId=${kappiId}&limit=200`, { headers: { cookie: opsCookie } })).json() as { data: { id: string, action: string, entityId: string }[] }
    const fresh = after.data.filter(r => !seenIds.has(r.id))
    expect(fresh.some(r => r.action === 'platform.request' && r.entityId.includes('/limits'))).toBe(true)
    expect(fresh.some(r => r.action === 'platform.request' && r.entityId === 'GET /api/v1/platform/tenants')).toBe(false)
  })
})
