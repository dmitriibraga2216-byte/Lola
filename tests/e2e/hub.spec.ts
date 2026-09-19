import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-оголошення '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await admin`delete from news where title like ${PREFIX + '%'}`
  await admin.end()
})

test('11. Объявление с обязательным прочтением: блокирует вход до «Ознайомився», в отчёте видно кто прочитал (docs/07 этап 10)', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const n = await api<{ id: string }>(request, csrf, 'post', '/news', { title: `${PREFIX}Нові правила`, body: [{ id: 'b1', type: 'text', html: '<p>З понеділка відкриваємо о 7:30.</p>' }], kind: 'announcement', publish: true })

  await loginViaUi(page, EMPLOYEE_PHONE)
  await expect(page.getByTestId('announcement-gate')).toBeVisible()
  await expect(page.getByText(`${PREFIX}Нові правила`)).toBeVisible()
  // Навигация не спасает — модалка на всех страницах кабинета
  await page.goto('/learn/catalog')
  await expect(page.getByTestId('announcement-gate')).toBeVisible()
  await page.getByTestId('announcement-ack').click()
  await expect(page.getByTestId('announcement-gate')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('announcement-gate')).toHaveCount(0)

  const rep = await api<{ acked: number, readers: { fullName: string }[], notAcked: { fullName: string }[] }>(request, csrf, 'get', `/news/${n.id}/report`)
  expect(rep.readers.map(r => r.fullName)).toContain('Кухар Тестовий')
  expect(rep.notAcked.map(r => r.fullName)).not.toContain('Кухар Тестовий')
})
