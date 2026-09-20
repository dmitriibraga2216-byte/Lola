import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-оголошення '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await admin`delete from assignments where subject_type = 'notice' and title like ${PREFIX + '%'}`
  await admin`delete from notices where title like ${PREFIX + '%'}`
  await admin.end()
})

test('11. Объявление с підписом: назначено сотруднику, блокирует вход до «Ознайомився», в охвате видно кто подтвердил (docs/21 §14.5, Spec 21)', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const n = await api<{ id: string }>(request, csrf, 'post', '/notices', { title: `${PREFIX}Нові правила`, body: [{ id: 'b1', type: 'text', html: '<p>З понеділка відкриваємо о 7:30.</p>' }], kind: 'acknowledge', blockUntilAck: true, publish: true })
  // Аудитория и срок — назначением, не в объявлении (CLAUDE.md п. 11)
  const [emp] = await admin`select id from users where phone = ${EMPLOYEE_PHONE}`
  await api(request, csrf, 'post', '/tasks', { subjectType: 'notice', subjectId: n.id, audience: { rules: [{ type: 'user', ids: [emp!.id] }], match: 'any' }, dueMode: 'relative', dueDays: 7 })

  await loginViaUi(page, EMPLOYEE_PHONE)
  await expect(page.getByTestId('announcement-gate')).toBeVisible()
  await expect(page.getByText(`${PREFIX}Нові правила`)).toBeVisible()
  // Навигация не спасает — модалка на всех страницах кабинета
  await page.goto('/learn/catalog')
  await expect(page.getByTestId('announcement-gate')).toBeVisible()
  // «Ознайомився» — один тап (мокап Notice)
  await page.getByTestId('announcement-ack').click()
  await expect(page.getByTestId('announcement-gate')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('announcement-gate')).toHaveCount(0)

  const cov = await api<{ acked: number, readers: { fullName: string }[], notAcked: { fullName: string }[] }>(request, csrf, 'get', `/notices/${n.id}/coverage`)
  expect(cov.readers.map(r => r.fullName)).toContain('Кухар Тестовий')
  expect(cov.notAcked.map(r => r.fullName)).not.toContain('Кухар Тестовий')
})
