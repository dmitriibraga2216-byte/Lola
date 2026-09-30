import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Звіти співбесід (docs/v2/30 §9.1, §9.2, §9.6): воронка, згоди, вивантаження — три вкладки,
 * фільтри, посилання на файл; 320 px без горизонтального скролу, вкладки — з клавіатури.
 */

test.beforeEach(resetOtp)

const noOverflow = async (page: import('@playwright/test').Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test('звіти співбесід: три вкладки, фільтри, файл — 320 px', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/admin/reports/interviews')
  await expect(page.getByRole('heading', { name: 'Звіти співбесід' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Воронка співбесід' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Показати' })).toBeVisible()
  await noOverflow(page)

  const consents = page.getByRole('tab', { name: 'Згоди' })
  await consents.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/r=consents/)
  await expect(consents).toHaveAttribute('aria-selected', 'true')
  await noOverflow(page)

  await page.getByRole('tab', { name: 'Вивантаження співбесід' }).click()
  await expect(page).toHaveURL(/r=sessions/)
  await expect(page.getByText('Розшифровок, цитат і посилань на аудіо тут немає')).toBeVisible()
  await expect(page.getByTestId('interview-report-xlsx')).toHaveAttribute('href', /\/api\/v1\/reports\/interviews\/sessions\?.*format=xlsx/)
  await noOverflow(page)
})
