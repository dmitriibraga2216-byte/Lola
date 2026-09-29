import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Проход администратора по формам на iPad (docs/v2/46-progress.md, запись 2026-09-29):
 *  - «Заявки» открываются без 500 (очередь `GET /development/requests/pending`);
 *  - в «Створити план» список «Людина» не пуст (раньше клиент просил `limit=300` у `/people`,
 *    сервер отвечал 400, список молча оставался пустым);
 *  - неактивная «Зберегти» / «Далі» / «Створити» объясняет, чего не хватает;
 *  - «Шаблони сповіщень» и «Переклади» без горизонтальной прокрутки страницы;
 *  - у свежего тенанта без курсов и анкет — подсказка со ссылкой вместо пустого списка
 *    (пустые списки подставлены через `page.route`: у сида «Каппі» они не пусты).
 * Вьюпорт iPad Pro 11 в портрете; проект `desktop` (файл `admin-*`).
 */

test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true })

test.beforeEach(async ({ page }) => {
  await resetOtp()
  await loginViaUi(page, ADMIN_PHONE)
})

test('«Заявки»: очередь на решение открывается без ошибки сервера', async ({ page }) => {
  const pending = page.waitForResponse(r => r.url().includes('/api/v1/development/requests/pending'))
  await page.goto('/admin/development/requests')
  expect((await pending).status()).toBe(200)
})

test('«Створити план»: список «Людина» заполнен', async ({ page }) => {
  const people = page.waitForResponse(r => r.url().includes('/api/v1/people?'))
  await page.goto('/admin/development/plans')
  await page.getByRole('button', { name: 'Створити план' }).first().click()
  expect((await people).status()).toBe(200)
  await expect(page.getByRole('dialog').locator('select option:not([value=""])').first()).toBeAttached()
})

test('«Зустрічі»: неактивная «Зберегти» называет незаполненные поля', async ({ page }) => {
  await page.goto('/admin/meetups')
  const hint = page.getByTestId('mt-missing')
  await expect(page.getByTestId('mt-create')).toBeDisabled()
  await expect(hint).toContainText('назву')
  await expect(hint).toContainText('тренера')
  await page.getByTestId('mt-title').fill('Дегустація iPad')
  await expect(hint).not.toContainText('назву')
})

test('профілі посад: без опублікованих курсів — подсказка со ссылкой, «Створити» объясняет, почему неактивна', async ({ page }) => {
  await page.route('**/api/v1/courses', route => route.fulfill({ json: { data: [] } }))
  await page.goto('/admin/profiles')
  await expect(page.getByTestId('profiles-no-courses').getByRole('link')).toHaveAttribute('href', '/admin/courses')
  await expect(page.getByTestId('profiles-missing')).toContainText('хоча б один курс')
})

test('процедура оцінки: без анкет — подсказка со ссылкой вместо пустого списка, «Далі» объясняет, почему неактивна', async ({ page }) => {
  await page.route('**/api/v1/assessment/forms', route => route.fulfill({ json: { data: [] } }))
  await page.goto('/admin/assessment/cycles')
  await expect(page.getByTestId('cycle-no-forms').getByRole('link')).toHaveAttribute('href', '/admin/assessment/forms')
  await expect(page.getByTestId('cycle-next')).toBeDisabled()
  await expect(page.getByTestId('cycle-missing')).toContainText('анкету')
})

test('шаблоны уведомлений и переводы не дают странице ехать вбок на iPad', async ({ page }) => {
  for (const route of ['/admin/settings/notifications', '/admin/settings/translations']) {
    await page.goto(route)
    await page.waitForLoadState('networkidle')
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
    expect(sw, route).toBeLessThanOrEqual(cw)
  }
})
