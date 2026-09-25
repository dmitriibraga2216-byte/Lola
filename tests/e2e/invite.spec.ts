import { createHash, randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'

/**
 * Ссылка-приглашение (docs/01 §1.5 «для першого входу», docs/16 §8 `user_invited`): людина
 * відкриває `/invite?token=…` без сесії. Раніше сторінки не було — лінк вів на 404 (дефект з
 * баг-репорту, після виправлення доставки сповіщень #120 запрошення реально стали доходити).
 * Сценарій: дійсне запрошення відкривається (не 404), показує назву простору, «Увійти»
 * заводить сесію і веде в застосунок; протухле — зрозумілий текст, а не 404. 320 px.
 */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

const PHONE_PREFIX = '+38094'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.afterAll(async () => {
  const people = await admin`select id from users where phone like ${`${PHONE_PREFIX}%`}`
  const ids = people.map(r => r.id as string)
  if (ids.length) {
    await admin`delete from invitations where user_id in ${admin(ids)}`
    await admin`delete from users where id in ${admin(ids)}`
  }
  await admin`delete from rate_limits where key like 'invite:preview:%'`
  await admin.end()
})

async function makeInvitation(expiresInMs: number): Promise<{ token: string, tenantName: string }> {
  const [tenant] = await admin`select id, name from tenants where slug = 'kappi'`
  const phone = `${PHONE_PREFIX}${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [person] = await admin`insert into users (tenant_id, phone, full_name, status) values (${tenant!.id}, ${phone}, 'E2E Запрошення', 'invited') returning id`
  const token = randomBytes(24).toString('base64url')
  await admin`insert into invitations (tenant_id, user_id, token_hash, expires_at) values (${tenant!.id}, ${person!.id}, ${hashToken(token)}, ${new Date(Date.now() + expiresInMs).toISOString()})`
  return { token, tenantName: tenant!.name as string }
}

test('дійсне запрошення відкривається (не 404), показує простір і заводить сесію', async ({ page }) => {
  const { token, tenantName } = await makeInvitation(48 * 60 * 60 * 1000)

  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`/invite?token=${token}`)
  await expect(page.getByText(tenantName)).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  await page.getByTestId('invite-sign-in').click()
  await page.waitForURL(u => !u.pathname.startsWith('/invite'))
  expect(new URL(page.url()).pathname).toBe('/')
})

test('протухле запрошення — зрозумілий текст, не 404', async ({ page }) => {
  const { token } = await makeInvitation(-60_000)

  await page.goto(`/invite?token=${token}`)
  await expect(page.getByTestId('invite-invalid')).toHaveText('Запрошення застаріло, зверніться до адміністратора')
  await expect(page.getByRole('heading', { name: '404' })).toHaveCount(0)
})

test('невідомий токен — той самий текст, не 404', async ({ page }) => {
  await page.goto(`/invite?token=${randomBytes(24).toString('base64url')}`)
  await expect(page.getByTestId('invite-invalid')).toHaveText('Запрошення застаріло, зверніться до адміністратора')
})
