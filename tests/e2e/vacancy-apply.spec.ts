import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-16 (docs/v2/29-vacancies.md §13 к. 2, 7; §6.3; сквозные проверки 16 и 24
 * из `docs/v2/42` §5).
 *
 * Проверяется путь человека целиком и **без входа**: он открывает ссылку с телефона, читает
 * объявление, заполняет форму, подтверждает номер кодом и видит, что отклик принят. Ширина
 * окна — 320 px: кандидат приходит с телефона и второго устройства чаще всего не имеет
 * (сквозная проверка 24).
 */

const TITLE = 'E2E Вакансія публічна'
const PHONE = '+380679965001'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const vs = await admin`select id from vacancies where title = ${TITLE}`
  for (const v of vs) {
    await admin`delete from public_apply_attempts where vacancy_id = ${v.id}`
    await admin`delete from vacancy_applications where vacancy_id = ${v.id}`
  }
  const people = await admin`select id from users where phone = ${PHONE}`
  for (const r of people) {
    await admin`delete from enrollments where user_id = ${r.id}`
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from notifications where user_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`update users set vacancy_id = null where id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from assignments where title = ${TITLE}`
  for (const v of vs) {
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin`delete from rate_limits where key like 'apply:%'`
  await admin`update tenants set candidates_enabled = false where slug = 'kappi'`
  await admin.end()
})

test('16. Публічний контур: відгук без входу — форма, код підтвердження, кандидат і призначення', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })

  const [course] = await admin`select id from courses where status = 'published' order by title limit 1`
  const [location] = await admin`select id from locations order by name limit 1`
  const vacancy = await api<{ id: string }>(request, csrf, 'post', '/vacancies', {
    title: TITLE,
    courseId: String(course!.id),
    locationId: String(location!.id),
    city: 'Київ',
    employmentType: 'shift',
    descriptionHtml: '<p>Ми шукаємо бариста</p>',
    salaryFrom: 20000,
    salaryTo: 30000,
    salaryVisible: true,
  })
  await api(request, csrf, 'post', `/vacancies/${vacancy.id}/publish`)
  const [row] = await admin`select public_token from vacancies where id = ${vacancy.id}`
  const token = String(row!.public_token)

  // Телефон: кандидат приходит с него, и это не «ещё один размер экрана», а основной.
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`/j/${token}`)

  // §13 к. 2: объявление видно, вилка показана (salary_visible), внутренних имён нет.
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(page.getByText('Ми шукаємо бариста')).toBeVisible()
  await expect(page.getByText(/20000/)).toBeVisible()
  await expect(page.getByText(String(course!.id))).toHaveCount(0)

  // Ни одного горизонтального скролла на 320 px (сквозная проверка 24).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // §6.3: форма отклика. Код подтверждения приходит в ответе только в dev и CI (OTP_DEBUG=1).
  await page.getByLabel('Ім’я та прізвище').fill('Оксана Відгукнулась')
  await page.getByLabel('Телефон').fill(PHONE)
  await page.getByText(/Я даю згоду на обробку/).click()
  const applied = page.waitForResponse(r => r.url().includes('/apply') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Надіслати відгук' }).click()
  const body = await (await applied).json() as { data: { devCode?: string } }
  const code = body.data.devCode
  expect(code, 'в CI код возвращается вызывающему').toBeTruthy()

  await expect(page.getByText(/Підтвердьте контакт/)).toBeVisible()
  await page.getByLabel('Код із шести цифр').fill(code!)
  await page.getByRole('button', { name: 'Підтвердити' }).click()
  await expect(page.getByText(/Ваш відгук прийнято/)).toBeVisible()

  // §13 к. 7: кандидат создан, источник — публичная ссылка, назначение ровно одно.
  const [person] = await admin`select id, kind, source, vacancy_id from users where phone = ${PHONE}`
  expect(person!.kind).toBe('candidate')
  expect(person!.source).toBe('vacancy_link')
  expect(person!.vacancy_id).toBe(vacancy.id)
  const assignments = await admin`select id from assignments where ${`vacancy:${vacancy.id}`} = any(tags)`
  expect(assignments.length).toBe(1)
})

test('16. Невідомий токен віддає «не знайдено», а не сторінку чужої вакансії', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const res = await page.goto('/j/aaaaaaaaaaaaaaaaaaaaaa')
  // Страница отдаётся, но вакансии в ней нет: контур не различает чужой и несуществующий токен.
  expect(res?.status()).toBeLessThan(400)
  await expect(page.getByText(/не знайдено|not found|не найдено/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Надіслати відгук' })).toHaveCount(0)
})
