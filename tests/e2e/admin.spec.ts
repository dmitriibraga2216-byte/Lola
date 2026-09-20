import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, cleanupCourses, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-admin '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await cleanupCourses(PREFIX)
  await admin`delete from users where full_name like 'E2E Імпорт%'`
})

test('5. Методист создаёт курс из редактора и публикует за один сеанс', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/courses')
  // Карточка курса (docs/11 §14.1): назва, код, «Визначати результат по»
  await page.getByRole('button', { name: /^Додати$/ }).click()
  await page.getByLabel(/Назва нового курсу/).fill(`${PREFIX}Редактор`)
  await page.getByLabel(/^Код$/).fill('E2E-01')
  await page.getByRole('button', { name: /Створити/ }).click()
  await expect(page).toHaveURL(/\/admin\/courses\/[0-9a-f-]+$/)

  // Раздел обязателен: без него элементы плана не подключить
  await expect(page.getByText(/Спочатку додайте розділ/)).toBeVisible()
  await page.getByPlaceholder(/Назва розділу/).fill('Розділ 1')
  await page.getByRole('button', { name: /Додати розділ/ }).click()
  await expect(page.locator('.section-title', { hasText: 'Розділ 1' })).toBeVisible()
  await page.getByPlaceholder(/Новий урок/).fill('Перший урок')
  await page.getByRole('button', { name: /Створити і підключити ресурс/ }).click()
  await expect(page.getByRole('button', { name: /Перший урок/ })).toBeVisible()

  // Вводим текст в блок и ждём автосохранения
  await page.locator('textarea').first().fill('<p>Привіт, це перший урок</p>')
  await expect(page.getByText(/Збережено о/)).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: /Опублікувати/ }).first().click()
  await expect(page.getByText(/У курсі є хоча б один урок/)).toBeVisible()
  await page.getByPlaceholder(/Що змінилось/).fill('Перша публікація')
  await page.locator('.modal').getByRole('button', { name: /Опублікувати/ }).click()
  await expect(page.getByText(/Опубліковано версію 1/)).toBeVisible()
})

test('6. Назначение: конструктор аудитории показывает счётчик, назначает, запись появляется у человека', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Призначення` })
  const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Р' })
  await api(request, csrf, 'post', `/courses/${course.id}/lessons`, { moduleId: mod.id, title: 'У', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] } })
  await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша версія' })

  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/assignments/new')
  await page.locator('select').first().selectOption({ label: `${PREFIX}Призначення` })
  await page.getByRole('button', { name: 'Роль' }).click()
  await page.locator('.rule select').selectOption({ label: 'Співробітник' })
  await expect(page.getByText(/Під умову підпадає \d+ людей/)).toBeVisible()
  const counter = await page.getByText(/Під умову підпадає (\d+) людей/).textContent()
  const n = Number(counter!.match(/(\d+)/)![1])
  expect(n).toBeGreaterThan(0)

  page.once('dialog', d => d.accept())
  await page.getByRole('button', { name: /^Призначити$/ }).click()
  await expect(page).toHaveURL(/\/admin\/assignments\/[0-9a-f-]+$/)
  await expect(page.getByText(String(n)).first()).toBeVisible()

  // У сотрудника запись появилась
  const [e] = await admin`select e.id from enrollments e join users u on u.id = e.user_id join courses c on c.id = e.subject_id where u.phone = ${EMPLOYEE_PHONE} and c.id = ${course.id}`
  expect(e).toBeDefined()
})

test('7. Импорт: предпросмотр с ошибками, применение, отчёт', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/import')
  const stamp = Date.now()
  const csv = ['ПІБ,Телефон,Посада,Підрозділ,Точка,Роль',
    `E2E Імпорт Один ${stamp},+38093${String(stamp).slice(-7)},Бариста,Каппі,Лазарева,employee`,
    `E2E Імпорт Два ${stamp},12345,Бариста,Каппі,Лазарева,employee`, // кривой телефон
    `,+38093${String(stamp + 1).slice(-7)},Бариста,Каппі,Лазарева,employee`, // нет имени
  ].join('\n')
  await page.setInputFiles('input[type="file"]', { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') })
  await page.getByRole('button', { name: /Перевірити/ }).click()
  await expect(page.getByText('3').first()).toBeVisible()
  await expect(page.getByText(/Телефон: невірний формат/)).toBeVisible()
  await expect(page.getByText(/ПІБ: обовʼязкове/)).toBeVisible()
  await page.getByRole('button', { name: /Застосувати \(1\)/ }).click()
  await expect(page.getByText(/створено 1, оновлено 0/)).toBeVisible()
  await expect(page.getByRole('link', { name: /Завантажити звіт/ })).toBeVisible()
})

test('8. Доступ: employee не открывает админку ни по ссылке, ни по API', async ({ page, request }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/admin/people')
  await expect(page).toHaveURL(/\/$/) // гард увёл на главную
  await expect(page.getByRole('link', { name: 'Управління' })).toHaveCount(0)

  await apiLogin(request, EMPLOYEE_PHONE)
  for (const path of ['/api/v1/people', '/api/v1/courses', '/api/v1/assignments', '/api/v1/audit']) {
    const res = await request.get(path)
    expect(res.status(), path).toBe(403)
  }
})
