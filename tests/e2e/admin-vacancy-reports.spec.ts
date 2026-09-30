import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * «Звіти вакансій» — `/admin/reports/vacancies` (docs/v2/29 §9.1–§9.5; vacancies-tails, часть 2):
 * пять вкладок переключаются, фильтр площадки есть только там, где он имеет смысл, выгрузка —
 * ссылкой с тем же фильтром, 320px без горизонтальной прокрутки страницы. Цифры и область —
 * `tests/integration/v2-vacancy-reports.spec.ts`.
 */

test.beforeEach(resetOtp)

test('звіти вакансій: вкладки, фільтр майданчика, вивантаження; 320px', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/reports/vacancies')
  await expect(page.getByRole('heading', { name: 'Звіти вакансій' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Ефективність вакансії' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Майданчик')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Майданчики' }).click()
  await expect(page).toHaveURL(/r=boards/)
  await expect(page.getByLabel('Майданчик')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Вивантажити XLSX' })).toHaveAttribute('href', /\/reports\/vacancies\/boards\?.*format=xlsx/)

  await page.getByRole('tab', { name: 'Захист сторінок' }).click()
  await expect(page.getByText('IP-адрес у звіті немає.', { exact: false })).toBeVisible()

  await page.setViewportSize({ width: 320, height: 720 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'test-results/admin-vacancy-reports-320.png', fullPage: true })
})
