import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.OTP_DEBUG = '1'

const { requestOtp, verifyOtp } = await import('../../server/services/otp')
const { createSession, validateSession, revokeSession, revokeAllSessions }
  = await import('../../server/services/session')
const { loadAccess, can } = await import('../../server/services/access')
const { usersByPhone } = await import('../../server/services/authLookup')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

// Отдельный тестовый номер, чтобы не задевать сид и rate-лимиты между прогонами
const PHONE = `+38066${String(Math.floor(Math.random() * 1_0000_000)).padStart(7, '0')}`
let tenantId: string
let userId: string
let employeeId: string

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string

  const [u] = await admin`
    insert into users (tenant_id, phone, full_name, status)
    values (${tenantId}, ${PHONE}, 'Тест Автентифікації', 'active')
    returning id
  `
  userId = u!.id as string

  const [adminRole] = await admin`select id from roles where tenant_id = ${tenantId} and code = 'admin'`
  await admin`
    insert into user_roles (tenant_id, user_id, role_id, scope_type)
    values (${tenantId}, ${userId}, ${adminRole!.id}, 'tenant')
  `

  const [emp] = await admin`
    select u.id from users u
    join user_roles ur on ur.user_id = u.id
    join roles r on r.id = ur.role_id
    where u.tenant_id = ${tenantId} and r.code = 'employee' and u.status = 'active'
      and not exists (
        select 1 from user_roles ur2 join roles r2 on r2.id = ur2.role_id
        where ur2.user_id = u.id and r2.code in ('admin', 'author', 'manager', 'mentor')
      )
    order by u.id
    limit 1
  `
  employeeId = emp!.id as string
})

afterAll(async () => {
  await admin`delete from rate_limits where key like ${`%${PHONE}%`}`
  // Номер «неизвестного» из первого сценария — литерал, а не случайный: его счётчик
  // переживал прогон и на четвёртом подряд прогоне по одной и той же базе блокировал
  // отправку, роняя сценарий «наличие не раскрывается». На чистой базе (CI) не видно.
  await admin`delete from rate_limits where key in ('otp:send:+380000000000', 'otp:ip:10.0.0.1')`
  await admin`delete from otp_codes where phone = ${PHONE}`
  await admin`delete from users where id = ${userId}`
  await admin.end()
})

describe('OTP-вход', () => {
  it('неизвестный номер получает одинаковый ответ (наличие не раскрывается)', async () => {
    const res = await requestOtp('+380000000000', '10.0.0.1')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.devCode).toBeUndefined()
  })

  it('код приходит, неверный ввод тратит попытки, верный — проходит', async () => {
    const res = await requestOtp(PHONE, '10.0.0.2')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.devCode).toMatch(/^\d{6}$/)

    const bad = await verifyOtp(PHONE, res.devCode === '000000' ? '000001' : '000000')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('otp_invalid')

    const good = await verifyOtp(PHONE, res.devCode!)
    expect(good.ok).toBe(true)

    // Код одноразовый
    const replay = await verifyOtp(PHONE, res.devCode!)
    expect(replay.ok).toBe(false)
  })

  it('лимит отправок: 4-я подряд отклоняется', async () => {
    await requestOtp(PHONE, '10.0.0.3')
    await requestOtp(PHONE, '10.0.0.3')
    const fourth = await requestOtp(PHONE, '10.0.0.3') // 2-я и 3-я в этом тесте, 1-я — выше
    // после трёх отправок в окне четвёртая падает
    const fifth = await requestOtp(PHONE, '10.0.0.3')
    expect(fourth.ok || fifth.ok).toBe(false)
  })

  it('5 неверных кодов блокируют номер на 30 минут', async () => {
    await admin`delete from rate_limits where key like ${`%${PHONE}%`}`
    const res = await requestOtp(PHONE, '10.0.0.4')
    expect(res.ok).toBe(true)
    if (!res.ok) return

    for (let i = 0; i < 5; i++) {
      await verifyOtp(PHONE, '999999')
    }
    const blocked = await verifyOtp(PHONE, res.devCode!)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('rate_limited')

    const sendBlocked = await requestOtp(PHONE, '10.0.0.4')
    expect(sendBlocked.ok).toBe(false)
  })
})

describe('сессии', () => {
  it('создание, проверка, отзыв', async () => {
    const { token } = await createSession({ tenantId, userId })
    const auth = await validateSession(token)
    expect(auth).not.toBeNull()
    expect(auth!.tenantId).toBe(tenantId)
    expect(auth!.userId).toBe(userId)

    await revokeSession(auth!)
    expect(await validateSession(token)).toBeNull()
  })

  it('выйти на всех устройствах отзывает все сессии', async () => {
    const a = await createSession({ tenantId, userId })
    const b = await createSession({ tenantId, userId })
    const auth = await validateSession(a.token)
    const revoked = await revokeAllSessions(auth!)
    expect(revoked).toBeGreaterThanOrEqual(2)
    expect(await validateSession(a.token)).toBeNull()
    expect(await validateSession(b.token)).toBeNull()
  })

  it('битый токен не проходит', async () => {
    expect(await validateSession('not-a-token')).toBeNull()
  })
})

describe('скоупы: employee не имеет доступа к админке', () => {
  it('у admin есть settings.tenant и people.view, у employee — нет', async () => {
    const adminAccess = await loadAccess({ sessionId: 'x', tenantId, userId, impersonatedBy: null, activeRoleId: null, previewRoleId: null })
    expect(adminAccess).not.toBeNull()
    expect(can(adminAccess!, 'settings.tenant')).toBe(true)
    expect(can(adminAccess!, 'people.view')).toBe(true)

    const empAccess = await loadAccess({ sessionId: 'x', tenantId, userId: employeeId, impersonatedBy: null, activeRoleId: null, previewRoleId: null })
    expect(empAccess).not.toBeNull()
    expect(can(empAccess!, 'settings.tenant')).toBe(false)
    expect(can(empAccess!, 'people.view')).toBe(false)
    expect(can(empAccess!, 'people.import')).toBe(false)
    // а учиться — может
    expect(can(empAccess!, 'learn.view')).toBe(true)
  })

  it('поиск по телефону отдаёт тенантов пользователя', async () => {
    const found = await usersByPhone(PHONE)
    expect(found.length).toBe(1)
    expect(found[0]!.tenant_id).toBe(tenantId)
  })
})
