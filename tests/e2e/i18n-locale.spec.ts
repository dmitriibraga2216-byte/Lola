import { expect, test } from '@playwright/test'
import { EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Переключатель языка интерфейса (docs/24 §3.1, §3.6): PATCH /me/locale в «Профілі»
 * меняет активную локаль useI18n() сразу (без ручного reload) и переживает перезаход,
 * потому что хранится не в браузере, а в `users.locale`.
 */

test.beforeEach(resetOtp)

// Локаль человека — общий ресурс employee-пользователя между файлами тестов; кто включил, тот и выключает.
test.afterEach(async ({ request }) => {
  const { csrf } = await apiLogin(request, EMPLOYEE_PHONE)
  await api(request, csrf, 'patch', '/me/locale', { locale: null })
})

test('переключение языка в профиле меняет интерфейс и переживает перезаход', async ({ page }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/profile')

  const select = page.locator('.language select')
  await expect(page.getByText('Мова інтерфейсу')).toBeVisible()
  await expect(select).toHaveValue('')

  // Переключение на русский — без перезагрузки страницы, реактивно через useI18n().locale
  await select.selectOption('ru')
  await expect(page.getByText('Язык интерфейса')).toBeVisible()
  await expect(page.getByText('Ещё')).toBeVisible() // t('profile.more') — другой ключ той же страницы

  // Перезаход: выбор лежит в users.locale, не в localStorage/cookie браузера
  await page.reload()
  await expect(page.getByText('Язык интерфейса')).toBeVisible()
  await expect(select).toHaveValue('ru')

  // Наследование локали пространства: пустой выбор возвращает украинский (локаль тенанта по умолчанию — uk)
  await select.selectOption('')
  await expect(page.getByText('Мова інтерфейсу')).toBeVisible()
})
