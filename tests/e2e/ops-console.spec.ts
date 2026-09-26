import { expect, test } from '@playwright/test'
import { hash as argonHash } from '@node-rs/argon2'
import postgres from 'postgres'
import { totpAt } from '../../server/services/totp'

/**
 * Консоль оператора (docs/25 §7 п. 6–8, ops-console-1): вход с обязательным вторым фактором —
 * пароль → подключение приложения → резервные коды → список компаний; повторный вход — кодом.
 * Прогон без `OPS_HOST`: консоль по пути `/ops` на общем хосте (как в dev).
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
const EMAIL = 'ops1-e2e@lola.test'
const PASSWORD = 'ops1-e2e-password'

test.beforeAll(async () => {
  await admin`delete from rate_limits where key like ${'ops%'}`
  await admin`insert into platform_admins (email, full_name, password_hash, role) values (${EMAIL}, 'E2E Оператор', ${await argonHash(PASSWORD)}, 'owner')
    on conflict (email) do update set password_hash = excluded.password_hash, role = 'owner', is_active = true,
      totp_secret_encrypted = null, totp_secret_nonce = null, totp_confirmed_at = null, totp_last_used_step = null`
})

test.afterAll(async () => {
  await admin`delete from platform_admins where email = ${EMAIL}`
  await admin.end()
})

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/ops/login')
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.locator('#ops-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await expect(page).toHaveURL(/\/ops\/two-factor/)
}

test('оператор: пароль → подключение 2FA → список компаний; следующий вход — кодом', async ({ page }) => {
  // Без сессии консоль ведёт на вход
  await page.goto('/ops/companies')
  await expect(page).toHaveURL(/\/ops\/login/)

  await signIn(page)
  const secret = (await page.getByTestId('two-factor-secret').textContent())!.replace(/\s/g, '')
  expect(secret.length).toBeGreaterThan(20)
  // Пока фактор не подключён, консоль закрыта и на уровне API
  const blocked = await page.request.get('/api/v1/platform/companies')
  expect(blocked.status()).toBe(401)
  expect((await blocked.json()).error.code).toBe('two_factor_required')

  await page.getByTestId('two-factor-confirm-code').fill(totpAt(secret, Date.now()))
  await page.getByTestId('two-factor-confirm').click()
  await expect(page.getByTestId('two-factor-recovery-codes').locator('li')).toHaveCount(10)
  await page.getByTestId('two-factor-saved').check()
  await page.getByTestId('two-factor-done').click()

  await expect(page).toHaveURL(/\/ops\/companies/)
  await expect(page.getByRole('heading', { name: 'Компанії' })).toBeVisible()
  await expect(page.getByTestId('ops-companies').getByText('kappi', { exact: true })).toBeVisible()
  await page.getByPlaceholder('Пошук за назвою або slug').fill('zzz-нема-такої')
  await expect(page.getByText('Нічого не знайдено')).toBeVisible()

  // Выход и повторный вход — уже экран кода, не подключения
  await page.request.post('/api/v1/platform/logout')
  await admin`delete from rate_limits where key like ${'ops%'}`
  await signIn(page)
  await expect(page.getByTestId('two-factor-secret')).toHaveCount(0)
  // Следующий шаг TOTP: код текущего шага уже принят при подключении и повторно не проходит
  await page.waitForTimeout(Math.max(0, 30_000 - (Date.now() % 30_000)) + 500)
  await page.locator('#ops-code').fill(totpAt(secret, Date.now()))
  await page.getByRole('button', { name: 'Підтвердити' }).click()
  await expect(page).toHaveURL(/\/ops\/companies/)
})
