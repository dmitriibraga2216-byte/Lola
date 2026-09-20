import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-чек '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await admin`delete from checklist_runs where checklist_id in (select id from checklists where title like ${PREFIX + '%'})`
  await admin`delete from checklists where title like ${PREFIX + '%'}`
  await admin.end()
})

test('9. Чек-лист заполняется с телефона на точке: критический провал → план действий → отчёт (docs/20 §13.3–13.4)', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const scales = await api<{ id: string, name: string }[]>(request, csrf, 'get', '/scales?kind=levels')
  const scaleId = scales.find(s => s.name === 'Зараховано / Не зараховано')!.id
  const cl = await api<{ id: string }>(request, csrf, 'put', '/checklists', {
    title: `${PREFIX}Відкриття`, kind: 'observation', subjectKind: 'location', scaleId, scoring: 'percent', passScore: 80, criticalFailRule: 'any_critical_fails_all', whoCanRun: { roles: ['manager', 'admin'] },
    items: [
      { id: 'a', group: 'Зал', text: 'Столи протерті', weight: 1 },
      { id: 'b', group: 'Кухня', text: 'Холодильник ≤ 4°C', weight: 2, isCritical: true },
      { id: 'c', group: 'Кухня', text: 'Маркування', weight: 1 },
    ],
  })

  await loginViaUi(page, ADMIN_PHONE)
  const started = Date.now()
  await page.goto('/learn/checklists')
  await page.getByTestId(`cl-${cl.id}`).click()
  await page.getByTestId('run-start').click()
  await expect(page).toHaveURL(/\/learn\/checklists\/run\//)

  // Два пункта зараховано, критический — провален
  await page.getByTestId('item-a').getByRole('radio', { name: 'Зараховано', exact: true }).click()
  await page.getByTestId('item-b').getByRole('radio', { name: 'Не зараховано', exact: true }).click()
  await page.getByTestId('item-c').getByRole('radio', { name: 'Зараховано', exact: true }).click()
  await expect(page.getByText('Виконано 3 з 3')).toBeVisible()
  await page.getByTestId('run-finish').click()

  // Не пройдено → план действий обязателен
  await expect(page.getByText(/додайте план дій/)).toBeVisible()
  await expect(page.getByText('0%').first()).toBeVisible()
  await page.getByPlaceholder('Що виправити').fill('Викликати майстра')
  await page.locator('input[type=date]').fill('2026-12-31')
  await page.getByTestId('run-send').click()
  await expect(page).toHaveURL(/\/learn\/checklists$/)
  await expect(page.getByText('0%').first()).toBeVisible()
  expect(Date.now() - started).toBeLessThan(3 * 60_000)

  // Попал в отчёт с планом действий
  const report = await api<{ runs: { title: string, passed: boolean, critical_failed: string[], action_plan: unknown[] }[] }>(request, csrf, 'get', `/reports/checklists?checklistId=${cl.id}`)
  expect(report.runs[0]).toMatchObject({ title: `${PREFIX}Відкриття`, passed: false, critical_failed: ['b'] })
  expect(report.runs[0]!.action_plan).toHaveLength(1)
})
