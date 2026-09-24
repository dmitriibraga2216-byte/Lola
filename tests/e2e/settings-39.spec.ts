import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, EMPLOYEE_PHONE, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-39 пакета `docs/v2` (`45-plan.md`): настройки тенанта и платформы.
 *
 * 1. **Публичная витрина оргструктуры** (`docs/v2/32` §13 к. 8; патч П-21 «Также»): старая
 *    «публічна оргструктура» хаба заменена витриной дерева подчинения — сотрудник по старому
 *    адресу попадает на `/org-structure`, где есть только таб просмотра, а справочное дерево
 *    админки `/org/tree` ему больше не открыто.
 * 2. **Блоки настроек компании** (П-24.1): «Простір» с колонтитулом и мовами, «Двофакторна
 *    автентифікація» с блоком «Мій вхід», «Поведінка таблиць» — видны администратору.
 * 3. **Объявления платформы** (П-21, П-24.2): своя страница «Оголошення Lola», отдельная от
 *    новостей компании, — только чтение.
 *
 * Полный сценарий второго фактора (подключение, код, резервный код, блокировка) — в
 * `tests/integration/v2-settings-39-auth.spec.ts`: там можно управлять часами «приложения»,
 * а здесь включённый фактор у посевного администратора ломал бы соседние сценарии входа.
 */

test.beforeEach(resetOtp)

test('сотрудник: старая оргструктура хаба ведёт на витрину, справочное дерево ему закрыто (к. 8, П-21)', async ({ page, request }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/org')
  await page.waitForURL(u => u.pathname === '/org-structure')
  await expect(page.getByRole('tab', { name: 'Співробітник — перегляд' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Адмін — конструктор' })).toHaveCount(0)

  await resetOtp()
  await apiLogin(request, EMPLOYEE_PHONE)
  const tree = await request.get('/api/v1/org/tree')
  expect(tree.status()).toBe(403)
  const showcase = await request.get('/api/v1/org-structure/tree?mode=view')
  expect(showcase.ok()).toBe(true)
})

test('администратор: блоки настроек компании — колонтитул, 2FA, поведение таблиц', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/settings/policies')
  await page.getByRole('button', { name: 'Простір', exact: true }).click()
  await expect(page.getByTestId('content-footer-toggle')).toBeVisible()
  await page.getByRole('button', { name: 'Двофакторна автентифікація', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Мій вхід' })).toBeVisible()
  await expect(page.getByTestId('two-factor-enroll')).toBeVisible()
  // Требование нельзя включить, пока свой фактор не подключён — чекбокс неактивен
  await expect(page.getByTestId('two-factor-required')).toBeDisabled()
  await page.getByRole('button', { name: 'Поведінка таблиць', exact: true }).click()
  const autoLoad = page.getByTestId('tables-auto-load')
  await expect(autoLoad).not.toBeChecked()
  await autoLoad.check()
  // Настройка браузера: переживает перезагрузку, на сервер не уходит
  await page.reload()
  await page.getByRole('button', { name: 'Поведінка таблиць', exact: true }).click()
  await expect(page.getByTestId('tables-auto-load')).toBeChecked()
  await page.getByTestId('tables-auto-load').uncheck()
})

test('объявления платформы — своя страница «Оголошення Lola», только чтение', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/platform-announcements')
  await expect(page.getByRole('heading', { name: 'Оголошення платформи Lola' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Створити|Опублікувати/ })).toHaveCount(0)
})
