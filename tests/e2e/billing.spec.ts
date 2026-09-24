import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * PR-10 пакета docs/v2 (docs/v2/35-billing-limits.md §5.1, §5.3, §13 критерии 4, 6):
 * екран «Тариф і ліміти», історія платежів, розмежування admin/owner (§2: суми бачить
 * лише owner). «Адмін Каппі» в сиде тримає обидві ролі — той самий фікстур, що в
 * admin-roles-owner.spec.ts.
 */

test.beforeEach(resetOtp)

async function switchToOwner(page: import('@playwright/test').Page) {
  await page.locator('.who').click()
  await page.getByRole('menuitemradio', { name: /Власник/ }).click()
}

test('admin бачить тариф без суми і без історії платежів', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/settings/billing')

  await expect(page.getByRole('heading', { name: 'Тариф і ліміти' })).toBeVisible()
  await expect(page.getByText('Поточний тариф')).toBeVisible()
  await expect(page.getByText('Історія платежів')).toHaveCount(0)

  // Суми — тільки owner (§2): сервер не віддає ціну, а не просто ховає її стилями
  const summary = await page.request.get('/api/v1/billing/summary')
  expect(summary.ok()).toBeTruthy()
  const { data } = await summary.json() as { data: { priceMinor: number | null } }
  expect(data.priceMinor).toBeNull()

  // Історія платежів — 403, а не часткові дані (§13 к. 10, той самий принцип, що для employee)
  const payments = await page.request.get('/api/v1/billing/payments')
  expect(payments.status()).toBe(403)
})

test('owner бачить посилання на історію платежів, порожню за відсутності платежів', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/people') // стартовий екран під роллю «Адміністратор» — переключення на «Власник» звідти
  await switchToOwner(page)

  await page.goto('/admin/settings/billing')
  await expect(page.getByText('Поточний тариф')).toBeVisible()
  const historyLink = page.getByRole('link', { name: 'Історія платежів' })
  await expect(historyLink).toBeVisible()

  await historyLink.click()
  await expect(page).toHaveURL(/\/admin\/settings\/billing\/history$/)
  await expect(page.getByText('Платежів ще не було')).toBeVisible()
})
