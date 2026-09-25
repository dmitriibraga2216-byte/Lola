import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { previewInvitation } = await import('../../server/services/people')
const { hashToken } = await import('../../server/services/session')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

/**
 * `previewInvitation` — превью сторінки `/invite` перед входом (docs/01 §1.5): назва простору
 * для дійсного токена, `null` для невідомого/протухлого/уже прийнятого — без жодних побічних
 * ефектів (не позначає запрошення прийнятим, на відміну від `POST /auth/invite/accept`).
 */
describe('previewInvitation (страница /invite перед входом)', () => {
  let tenantId: string, tenantName: string, userId: string
  const invitationIds: string[] = []

  beforeAll(async () => {
    const [t] = await admin`select id, name from tenants where slug = 'kappi'`
    tenantId = t!.id as string
    tenantName = t!.name as string

    const phone = `+38095${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
    const [u] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenantId}, ${phone}, 'Тест Запрошення', 'invited') returning id`
    userId = u!.id as string
  })

  afterAll(async () => {
    if (invitationIds.length) await admin`delete from invitations where id in ${admin(invitationIds)}`
    await admin`delete from users where id = ${userId}`
    await admin.end()
  })

  async function makeInvitation(opts: { expiresInMs: number, acceptedAt?: Date }): Promise<string> {
    const token = randomBytes(24).toString('base64url')
    const [row] = await admin`
      insert into invitations (tenant_id, user_id, token_hash, expires_at, accepted_at)
      values (${tenantId}, ${userId}, ${hashToken(token)}, ${new Date(Date.now() + opts.expiresInMs).toISOString()}, ${opts.acceptedAt?.toISOString() ?? null})
      returning id
    `
    invitationIds.push(row!.id as string)
    return token
  }

  it('дійсне запрошення — назва простору, без побічних ефектів (можна прочитати кілька разів)', async () => {
    const token = await makeInvitation({ expiresInMs: 48 * 60 * 60 * 1000 })
    expect(await previewInvitation(token)).toEqual({ tenantName })
    expect(await previewInvitation(token)).toEqual({ tenantName })
  })

  it('протухле (48 годин) — null, а не назва простору', async () => {
    const token = await makeInvitation({ expiresInMs: -60_000 })
    expect(await previewInvitation(token)).toBeNull()
  })

  it('вже прийняте — null', async () => {
    const token = await makeInvitation({ expiresInMs: 48 * 60 * 60 * 1000, acceptedAt: new Date() })
    expect(await previewInvitation(token)).toBeNull()
  })

  it('невідомий токен — null, а не помилка', async () => {
    expect(await previewInvitation(randomBytes(24).toString('base64url'))).toBeNull()
  })
})
