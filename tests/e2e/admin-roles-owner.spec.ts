import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Переключатель ролей и владение простором (docs/01 §1.2, §1.9.2, §1.9.4; docs/24 §3.5).
 *
 * «Адмін Каппі» в сиде держит две роли — `admin` и `owner`. Сценарий проверяет ровно то,
 * что просил заказчик: человек с несколькими ролями переключается, и интерфейс перестраивается
 * под активную роль, а не показывает объединение прав.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

/** Меню человека в подвале боковой панели — оно же переключатель ролей. */
async function openUserMenu(page: import('@playwright/test').Page) {
  await page.locator('.who').click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/**
 * Активная роль читается из самого переключателя (отмеченный пункт), а не из подписи под
 * именем: на узком экране подпись спрятана (`.who-text` скрыт до 860px), и проверка «видно
 * слово Власник» на мобильном проекте означала бы не то, что на десктопном.
 */
async function expectActiveRole(page: import('@playwright/test').Page, name: string) {
  await openUserMenu(page)
  await expect(page.getByRole('menuitemradio', { name: new RegExp(name) })).toHaveAttribute('aria-checked', 'true')
  await page.locator('.who').click() // закрыть меню тем же переключателем
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test.afterAll(async () => {
  // Владение возвращаем сиду: файлы e2e делят одну базу
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  const [u] = await admin`select id from users where tenant_id = ${t!.id} and phone = ${ADMIN_PHONE}`
  const [r] = await admin`select id from roles where tenant_id = ${t!.id} and code = 'owner'`
  await admin`delete from user_roles where tenant_id = ${t!.id} and is_owner`
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) values (${t!.id}, ${u!.id}, ${r!.id}, 'tenant')`
  // Соединение не закрываем: файл гоняется двумя проектами (mobile и desktop) в одном воркере,
  // и `admin.end()` после первого из них оставил бы второй без базы
})

test('переключение между ролями «Адміністратор» и «Власник» перестраивает разделы', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/people')

  // Роль по умолчанию — рабочая админка: у администратора есть раздел «Контент»
  await expectActiveRole(page, 'Адміністратор')
  await expect(page.getByRole('button', { name: 'Контент', exact: true })).toBeVisible()

  // Переключатель виден и перечисляет обе роли — радиогруппа, работает с клавиатуры
  await openUserMenu(page)
  const roleItems = page.getByRole('menuitemradio')
  await expect(roleItems).toHaveCount(2)
  await expect(roleItems.filter({ hasText: 'Адміністратор' })).toHaveAttribute('aria-checked', 'true')

  // Переходим во владельца: интерфейс перестраивается под активную роль
  await roleItems.filter({ hasText: 'Власник' }).click()
  await expect(page.getByRole('button', { name: 'Контент', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Люди', exact: true })).toBeVisible()

  // Права считает сервер: курсы владельцу не отдаются даже по прямой ссылке
  const forbidden = await page.request.get('/api/v1/courses')
  expect(forbidden.status()).toBe(403)
  const billing = await page.request.get('/api/v1/billing/usage')
  expect(billing.ok()).toBeTruthy() // а тариф — отдаются: это его дело

  // Экран «Ролі та права»: карточка владельца и передача владения
  await page.goto('/admin/settings/roles')
  await expect(page.getByRole('heading', { name: 'Власник простору' })).toBeVisible()
  await expect(page.locator('.owner')).toContainText('Адмін Каппі')
  await expect(page.locator('.owner')).toContainText('це ви')
  await expect(page.getByRole('button', { name: 'Передати володіння' })).toBeVisible()

  // Роль владельца есть в таблице со счётчиком людей, её набор прав не редактируется
  const ownerRow = page.locator('tbody tr', { hasText: 'owner' })
  await expect(ownerRow.locator('td').nth(2)).toHaveText('1') // колонка «Людей»
  await ownerRow.click()
  await expect(page.getByText(/Набір прав власника не змінюється/)).toBeVisible()
  await expect(page.locator('.scope input[type="checkbox"]').first()).toBeDisabled()

  // Возвращаемся в администратора — разделы возвращаются, передача владения исчезает
  await openUserMenu(page)
  await page.getByRole('menuitemradio').filter({ hasText: 'Адміністратор' }).click()
  await expect(page.getByRole('button', { name: 'Контент', exact: true })).toBeVisible()
  await expectActiveRole(page, 'Адміністратор')
  await page.goto('/admin/settings/roles')
  await expect(page.getByRole('heading', { name: 'Власник простору' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Передати володіння' })).toHaveCount(0)

  // Definition of Done: 320px и клавиатура. Экран не уезжает вбок, переключатель
  // открывается и срабатывает с Enter — мышь для смены роли не обязательна.
  await page.setViewportSize({ width: 320, height: 720 })
  await expect(page.getByRole('heading', { name: 'Власник простору' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.locator('.who').press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitemradio', { name: /Власник/ }).press('Enter')
  // Смена роли уводит на стартовый экран активной роли (§1.9.2): меню под новой ролью
  // может не содержать текущего раздела, поэтому остаться на месте нельзя
  await expect(page).toHaveURL(/\/admin\/people/)
  await expectActiveRole(page, 'Власник')
})

test('передача владения на экране ролей: владение уходит целиком, второй раз передать нечего', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)

  // Работаем ролью владельца — только у неё есть право `tenant.transfer`
  await page.goto('/admin/people')
  await openUserMenu(page)
  await page.getByRole('menuitemradio').filter({ hasText: 'Власник' }).click()
  await expect(page.getByRole('button', { name: 'Контент', exact: true })).toHaveCount(0)

  await page.goto('/admin/settings/roles')
  await page.getByRole('button', { name: 'Передати володіння' }).click()
  await page.getByLabel(/Кому передати володіння/).fill('Монастирна')
  const person = page.getByRole('button', { name: 'Монастирна Катерина' })
  await expect(person).toBeVisible()
  await expect(page.locator('.people li')).toHaveCount(1) // список уже отфильтрован — кликаем по тому, кого искали
  page.once('dialog', d => d.accept())
  const done = page.waitForResponse(r => r.url().includes('/settings/owner/transfer'))
  await person.click()
  expect((await done).ok()).toBeTruthy()

  await expect(page.locator('.owner')).toContainText('Монастирна Катерина')
  await expect(page.locator('.owner')).not.toContainText('це ви')
  // Владение ушло целиком: роли владельца у прежнего нет, передавать больше нечего
  await expect(page.getByRole('button', { name: 'Передати володіння' })).toHaveCount(0)
})
