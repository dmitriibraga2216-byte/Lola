import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, EMPLOYEE_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * PR-36 пакета docs/v2 (docs/v2/34-storage.md §5.1, §5.2): экран «Сховище» под
 * `/admin/settings/storage` — сводка «Використовується», разбивка «За етапом» девятью ключами
 * (решение В-10: восемь кодов этапов + «Інше»), вкладки «Кошик» и «Політики зберігання»
 * (строка на каждое из шестнадцати происхождений). Сотрудник экрана не видит — `storage.view`
 * есть только у `admin` и `owner`.
 */

test.beforeEach(resetOtp)

test('admin: сводка, разбивка за етапом — девять ключей, кошик і політики', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/settings/storage')

  await expect(page.getByRole('heading', { name: 'Сховище' })).toBeVisible()
  await expect(page.getByText(/Використовується:/)).toBeVisible()

  await page.getByRole('button', { name: 'За етапом' }).click()
  await expect(page.locator('.bar-row')).toHaveCount(9)
  await expect(page.locator('.bar-row').filter({ hasText: 'Інше' })).toHaveCount(1)

  await page.getByRole('link', { name: 'Кошик' }).click()
  await expect(page).toHaveURL(/\/admin\/settings\/storage\/trash$/)
  await expect(page.getByRole('heading', { name: 'Кошик' })).toBeVisible()

  await page.getByRole('link', { name: 'Політики зберігання' }).click()
  await expect(page).toHaveURL(/\/admin\/settings\/storage\/policies$/)
  await expect(page.locator('fieldset.policy')).toHaveCount(16)
  await expect(page.getByRole('button', { name: 'Зробити сухий прогон' })).toBeVisible()
})

test('employee: сводка сховища закрыта — 403, а не данные', async ({ page }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  const res = await page.request.get('/api/v1/storage/summary')
  expect(res.status()).toBe(403)
})
