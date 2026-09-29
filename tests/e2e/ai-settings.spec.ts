import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * «Налаштування → Штучний інтелект» (docs/v2/30 §5.6) і звіти ШІ (§9.3–§9.5): профілі
 * провайдерів, журнал викликів із фільтрами та вивантаженням, три звіти — на 320 px без
 * горизонтального скролу; вкладки перемикаються з клавіатури.
 */

test.beforeEach(resetOtp)

const noOverflow = async (page: import('@playwright/test').Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test('профілі провайдерів і журнал викликів — 320 px, клавіатура, форма профілю', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/admin/settings/ai')
  await expect(page.getByRole('heading', { name: 'Штучний інтелект' })).toBeVisible()

  const providersTab = page.getByRole('tab', { name: 'Профілі провайдерів' })
  await providersTab.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/tab=providers/)
  await expect(page.getByRole('heading', { name: 'Профілі провайдерів' })).toBeVisible()
  // Тенант без своїх профілів отримує заглушки платформи — по одній на роль
  await expect(page.getByText('Оцінка співбесіди').first()).toBeVisible()
  await noOverflow(page)

  await page.getByRole('button', { name: 'Новий профіль' }).click()
  await expect(page.getByLabel('Код')).toBeVisible()
  await expect(page.getByLabel('Скільки провайдер зберігає дані')).toBeVisible()
  await noOverflow(page)
  await page.getByRole('button', { name: 'Скасувати' }).click()

  await page.getByRole('tab', { name: 'Журнал викликів' }).click()
  await expect(page).toHaveURL(/tab=calls/)
  await expect(page.getByRole('heading', { name: 'Журнал викликів ШІ' })).toBeVisible()
  await expect(page.getByLabel('Вартість від')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Вивантажити журнал (Excel)' })).toHaveAttribute('href', /\/api\/v1\/ai\/calls\/export\?.*format=xlsx/)
  await noOverflow(page)
})

test('звіти ШІ: три вкладки, фільтр періоду, 320 px', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/admin/reports/ai')
  await expect(page.getByRole('heading', { name: 'Звіти ШІ' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Якість моделі' })).toHaveAttribute('aria-selected', 'true')
  await noOverflow(page)
  for (const name of ['Допомога перевіряючому', 'Вартість ШІ']) {
    await page.getByRole('tab', { name }).click()
    await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Показати' })).toBeVisible()
    await noOverflow(page)
  }
  await expect(page.getByLabel('Призначення')).toBeVisible()
})
