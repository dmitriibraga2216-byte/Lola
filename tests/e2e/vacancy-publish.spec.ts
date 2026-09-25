import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-17 (docs/v2/29-vacancies.md §13 к. 9, §7.9–§7.10, §7.13, план `45`).
 *
 * Проверяется то, что видно на экране, а не только в сервисе:
 * 1. «Створити з AI» заповнює блок і показує «Перевірте згенерований текст…» — публікація
 *    заблокована (критерій §13 к. 9);
 * 2. «Текст перевірено» знімає блокування, і вакансія публікується;
 * 3. вкладка «Інтеграції» підключає компанійський акаунт-заглушку, а картка вакансії
 *    записує публікацію вручну (обхідний шлях `44` §8) без жодного зовнішнього викликy.
 */

const TITLE = 'E2E ІІ-текст і публікація'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  await admin`delete from vacancy_publications where vacancy_id in (select id from vacancies where title = ${TITLE})`
  await admin`delete from job_board_accounts where label = ${'E2E company'}`
  await admin`delete from tenant_secrets where key like 'jobboard:%' and not exists (select 1 from job_board_accounts b where b.secret_ref = tenant_secrets.id)`
  const vs = await admin`select id from vacancies where title = ${TITLE}`
  for (const v of vs) {
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin.end()
})

test('17. ІІ-текст блокує публікацію до перевірки; ручна публікація без площадки', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })
  const vacancy = await api<{ id: string }>(request, csrf, 'post', '/vacancies', { title: TITLE })

  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/vacancies/${vacancy.id}`)

  // Курс і точка потрібні для публікації (§7.1) — заповнюємо одразу, щоб перевірити рівно
  // блокування текстом ІІ, а не відсутні поля.
  await page.getByLabel('Рекрутинговий курс').selectOption({ index: 1 })
  await page.getByLabel('Точка').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click()
  await expect(page.getByText(/Зміни вплинуть лише на нові відгуки/)).toBeVisible()

  // §7.10, §7.11: «Створити з AI» на першому блоці («Про вакансію») заповнює textarea.
  await page.getByRole('button', { name: 'Створити з AI' }).first().click()
  await expect(page.locator('.ai-block textarea').first()).not.toBeEmpty()

  // Критерій §13 к. 9: неперевірений блок блокує публікацію.
  await expect(page.getByText('Перевірте згенерований текст перед публікацією')).toBeVisible()
  await page.getByRole('button', { name: 'Опублікувати' }).click()
  await expect(page.getByText(/Перевірте згенерований текст перед публікацією/)).toBeVisible()
  await expect(page.getByText('Чернетка')).toBeVisible()

  // «Текст перевірено» знімає блокування без правки тексту.
  await page.getByRole('button', { name: 'Текст перевірено' }).click()
  await page.getByRole('button', { name: 'Опублікувати' }).click()
  await expect(page.getByText('Опублікована')).toBeVisible()

  const [row] = await admin`select ai_blocks from vacancies where id = ${vacancy.id}`
  expect((row!.ai_blocks as Record<string, { acknowledged?: boolean }>).description?.acknowledged).toBe(true)

  // Інтеграції: компанійський акаунт-заглушка (§7.14) і ручна публікація (`44` §8).
  await page.goto('/admin/vacancies?tab=integrations')
  await page.getByLabel('Назва (необов\'язково)').fill('E2E company')
  await page.getByRole('button', { name: 'Підключити' }).click()
  await expect(page.getByText('E2E company')).toBeVisible()
  await expect(page.getByText('Підключено')).toBeVisible()

  await page.goto(`/admin/vacancies/${vacancy.id}`)
  await page.getByText('Додати посилання вручну').click()
  await page.locator('details.manual select').selectOption({ label: 'Work.ua — E2E company' })
  await page.locator('details.manual input[type="url"]').fill('https://work.ua/jobs/e2e-example/')
  await page.locator('details.manual').getByRole('button', { name: 'Опублікувати' }).click()
  // Точний матч, а не підрядок: «Додати посилання вручну» теж містить слово «вручну»
  // регістронезалежно, і getByText('Вручну') хибно спрацював би на кнопці-перемикачі.
  await expect(page.getByText('Вручну', { exact: true })).toBeVisible()

  const [pub] = await admin`select state, external_url from vacancy_publications where vacancy_id = ${vacancy.id}`
  expect(pub!.state).toBe('manual')
  expect(pub!.external_url).toBe('https://work.ua/jobs/e2e-example/')
})
