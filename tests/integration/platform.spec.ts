import { createServer } from 'node:http'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { encrypt, decrypt } = await import('../../server/services/crypto')
const { setSecret, getSecret, integrationStatus, disconnect, SECRET_KEYS } = await import('../../server/services/secrets')
const { createTenant, platformLogin, validatePlatformSession, impersonate, checkPlanLimit, ensureFirstAdmin, updateTenant } = await import('../../server/services/platform')
const { createEndpoint, emitWebhook, deliverPending, listDeliveries, sign, retryDelivery } = await import('../../server/services/webhooks')
const { createToken, validateBearer, revokeToken } = await import('../../server/services/apiTokens')
const { validateSession } = await import('../../server/services/session')
const { withTenant } = await import('../../server/utils/withTenant')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
const createdTenants: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = 'ops-test@lola.local'
  process.env.PLATFORM_ADMIN_PASSWORD = 'test-password-123'
  await ensureFirstAdmin()
})

afterAll(async () => {
  for (const id of createdTenants) {
    await admin`delete from user_placements where tenant_id = ${id}`
    await admin`delete from user_roles where tenant_id = ${id}`
    await admin`update locations set manager_id = null where tenant_id = ${id}`
    await admin`delete from users where tenant_id = ${id}`
    await admin`delete from locations where tenant_id = ${id}`
    await admin`delete from positions where tenant_id = ${id}`
    await admin`delete from org_units where tenant_id = ${id}`
    await admin`delete from roles where tenant_id = ${id}`
    await admin`delete from audit_log where tenant_id = ${id}`
    await admin`delete from tenants where id = ${id}`
  }
  await admin`delete from platform_admins where email = 'ops-test@lola.local'`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'sms'`
  await admin`delete from webhook_endpoints where tenant_id = ${tenantId} and description like 'test%'`
  await admin`delete from api_tokens where tenant_id = ${tenantId} and name like 'test%'`
  await admin.end()
})

const ctx = () => ({ tenantId, actorId: adminId })

describe('секреты тенанта (docs/09 §9.4)', () => {
  it('AES-GCM round-trip; чужой nonce не расшифровывается', () => {
    const { ciphertext, nonce } = encrypt('super-secret')
    expect(decrypt(ciphertext, nonce)).toBe('super-secret')
    const other = encrypt('x')
    expect(() => decrypt(ciphertext, other.nonce)).toThrow()
  })

  it('имена ключей — константы; round-trip записали → прочитали → совпало; статус без значения', async () => {
    await setSecret(ctx(), 'sms', SECRET_KEYS.sms.API_KEY, 'sk-123', 'TurboSMS')
    await setSecret(ctx(), 'sms', SECRET_KEYS.sms.PROVIDER, 'log')
    expect(await getSecret(tenantId, 'sms', SECRET_KEYS.sms.API_KEY)).toBe('sk-123')
    expect(await getSecret(tenantId, 'sms', 'API_KEY')).toBeNull() // регистр важен — ловим ошибку docs/09

    const [row] = await admin`select value_encrypted from tenant_secrets where tenant_id = ${tenantId} and provider = 'sms' and key = 'api_key'`
    expect(Buffer.from(row!.value_encrypted as Buffer).toString()).not.toContain('sk-123')

    const st = await integrationStatus(ctx(), 'sms')
    expect(st.state).toBe('connected')
    expect(st.accountLabel).toBe('TurboSMS')
    expect(JSON.stringify(st)).not.toContain('sk-123')

    await disconnect(ctx(), 'sms')
    expect(await getSecret(tenantId, 'sms', SECRET_KEYS.sms.API_KEY)).toBeNull()
    expect((await integrationStatus(ctx(), 'sms')).state).toBe('not_configured')
  })
})

describe('панель оператора (docs/03 §3.12)', () => {
  let opsAuth: { adminId: string, email: string, fullName: string }

  it('вход оператора e-mail+пароль, сессия 12 часов', async () => {
    expect(await platformLogin('ops-test@lola.local', 'wrong')).toBeNull()
    const r = await platformLogin('ops-test@lola.local', 'test-password-123')
    expect(r).not.toBeNull()
    opsAuth = (await validatePlatformSession(r!.token))!
    expect(opsAuth.email).toBe('ops-test@lola.local')
  })

  it('новый тенант за один вызов: роли по матрице, точка, позиция, админ с размещением и ролью admin', async () => {
    const slug = `t${Date.now().toString(36)}`
    const r = await createTenant({ slug, name: 'Тест-мережа', adminPhone: '+380501112233', adminName: 'Власник', plan: 'trial', trialDays: 14 }, opsAuth)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    createdTenants.push(r.tenantId)

    const [{ roles }] = await admin<[{ roles: number }]>`select count(*)::int as roles from roles where tenant_id = ${r.tenantId} and is_system`
    expect(roles).toBe(5)
    const [adminRole] = await admin`select r.scopes from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = ${r.adminUserId} and r.code = 'admin'`
    expect((adminRole!.scopes as string[]).includes('settings.tenant')).toBe(true)
    const [pl] = await admin`select location_id from user_placements where user_id = ${r.adminUserId}`
    expect(pl).toBeDefined()
    const [loc] = await admin`select manager_id from locations where id = ${pl!.location_id}`
    expect(loc!.manager_id).toBe(r.adminUserId)
    const [t] = await admin`select plan, trial_ends_at from tenants where id = ${r.tenantId}`
    expect(t!.plan).toBe('trial')
    expect(new Date(t!.trial_ends_at as string).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000)

    // Изоляция: из «Каппі» новый тенант не виден
    const seen = await withTenant(tenantId, adminId, async tx => tx.execute(`select count(*)::int as n from users where tenant_id = '${r.tenantId}'`))
    expect((seen as unknown as { n: number }[])[0]!.n).toBe(0)

    const dup = await createTenant({ slug, name: 'x', adminPhone: '+380501112234', adminName: 'y' }, opsAuth)
    expect(dup.ok).toBe(false)
  })

  it('лимит тарифа: trial 30 пользователей; смена плана снимает', async () => {
    const tid = createdTenants[0]!
    const before = await checkPlanLimit(tid, 'users')
    expect(before.limit).toBe(30)
    expect(before.ok).toBe(true)
    await updateTenant(tid, { plan: 'network' }, opsAuth)
    expect((await checkPlanLimit(tid, 'users')).limit).toBe(1000)
    const [a] = await admin`select action from audit_log where tenant_id = ${tid} and action = 'tenant.update'`
    expect(a).toBeDefined()
  })

  it('impersonation: только с причиной, сессия работает, всё в журналах (приёмка этапа 6)', async () => {
    const r = await impersonate(tenantId, adminId, 'Розбір скарги користувача №42', opsAuth)
    expect(r).not.toBeNull()
    const auth = await validateSession(r!.token)
    expect(auth!.userId).toBe(adminId)
    const [sec] = await admin`select meta from security_log where tenant_id = ${tenantId} and event = 'impersonation.start' order by created_at desc limit 1`
    expect((sec!.meta as { by: string, reason: string }).by).toBe('ops-test@lola.local')
    expect((sec!.meta as { reason: string }).reason).toContain('скарги')
    const [aud] = await admin`select id from audit_log where tenant_id = ${tenantId} and action = 'user.impersonate' order by created_at desc limit 1`
    expect(aud).toBeDefined()
  })
})

describe('вебхуки наружу (docs/09 §9.5)', () => {
  let received: { headers: Record<string, string | string[] | undefined>, body: string }[] = []
  let failCount = 0
  let port = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      if (req.url === '/fail' && failCount++ < 1) { res.statusCode = 500; res.end('boom'); return }
      received.push({ headers: req.headers, body })
      res.statusCode = 200
      res.end('ok')
    })
  })

  beforeAll(async () => {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r() }))
  })
  afterAll(() => server.close())

  it('подписка на событие → доставка с подписью HMAC; события мимо подписки не шлются', async () => {
    const ep = await createEndpoint(ctx(), { url: `http://127.0.0.1:${port}/ok`, events: ['certificate.issued'], description: 'test ok' })
    expect(ep.secret).toMatch(/^whsec_/)

    await withTenant(tenantId, adminId, async (tx) => {
      expect(await emitWebhook(tx, tenantId, 'certificate.issued', { number: 'LO-TEST' })).toBe(1)
      expect(await emitWebhook(tx, tenantId, 'user.created', { userId: 'x' })).toBe(0)
    })
    const s = await deliverPending(tenantId)
    expect(s.delivered).toBe(1)
    const hit = received.find(r => r.body.includes('LO-TEST'))!
    expect(hit.headers['x-lola-event']).toBe('certificate.issued')
    expect(hit.headers['x-lola-signature']).toBe(sign(ep.secret, hit.body))

    const dl = await listDeliveries(ctx(), ep.id)
    expect(dl[0]!.status).toBe('delivered')
    expect(dl[0]!.statusCode).toBe(200)
  })

  it('500 → повтор с экспонентой; ручной retry доставляет', async () => {
    received = []
    failCount = 0
    const ep = await createEndpoint(ctx(), { url: `http://127.0.0.1:${port}/fail`, events: ['user.created'], description: 'test fail' })
    await withTenant(tenantId, adminId, tx => emitWebhook(tx, tenantId, 'user.created', { userId: 'u1' }))
    const s1 = await deliverPending(tenantId)
    expect(s1.retried).toBe(1)
    let [d] = await listDeliveries(ctx(), ep.id)
    expect(d!.status).toBe('pending')
    expect(d!.attempt).toBe(1)
    expect(d!.statusCode).toBe(500)

    // next_attempt_at через минуту — ручной повтор сразу
    await retryDelivery(ctx(), d!.id)
    const s2 = await deliverPending(tenantId)
    expect(s2.delivered).toBe(1);
    [d] = await listDeliveries(ctx(), ep.id)
    expect(d!.status).toBe('delivered')
  })
})

describe('API-токены (docs/09 §9.6)', () => {
  it('создание → показ один раз → Bearer проходит со скоупами → отзыв → отказ', async () => {
    const t = await createToken(ctx(), { name: 'test integr', scopes: ['people.view', 'people.import'], expiresInDays: 30 })
    expect(t.token).toMatch(/^lola_/)
    const [row] = await admin`select token_hash, prefix from api_tokens where id = ${t.id}`
    expect(row!.token_hash).not.toBe(t.token)
    expect(t.token.startsWith(row!.prefix as string)).toBe(true)

    const v = await validateBearer(t.token)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.auth.tenantId).toBe(tenantId)
      expect(v.auth.scopes).toEqual(['people.view', 'people.import'])
    }
    expect((await validateBearer('lola_nope')).ok).toBe(false)

    await revokeToken(ctx(), t.id)
    expect((await validateBearer(t.token)).ok).toBe(false)
  })

  it('лимит 60/мин на токен', async () => {
    const t = await createToken(ctx(), { name: 'test limit', scopes: ['people.view'] })
    let last: Awaited<ReturnType<typeof validateBearer>> = { ok: false, code: 'invalid' }
    for (let i = 0; i < 61; i++) last = await validateBearer(t.token)
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.code).toBe('rate_limited')
  })
})
