import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-14 (docs/v2/28-recruiting-candidates.md §13 к. 4, §5.2, §5.5):
 * рекрутер включает рекрутинг, видит кандидата на доске, открывает карточку и нанимает —
 * и после найма человек уже сотрудник, с той же историей и на том же `user_id`.
 *
 * Флаг `candidates_enabled` здесь не декорация: до него раздела нет в меню и ручки воронки
 * отвечают `403`. Поэтому сценарий начинается с включения и заканчивается возвратом флага в
 * исходное состояние — соседние сценарии не должны видеть чужой раздел.
 */

const PHONE = '+380679950001'
const NAME = 'E2E Кандидат Воронка'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const rows = await admin`select id from users where phone = ${PHONE}`
  for (const r of rows) {
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from candidate_scores where candidate_id = ${r.id}`
    await admin`delete from candidate_comments where candidate_id = ${r.id}`
    await admin`delete from employee_lifecycle_state where user_id = ${r.id}`
    await admin`delete from user_placements where user_id = ${r.id}`
    await admin`delete from user_roles where user_id = ${r.id}`
    await admin`delete from notifications where user_id = ${r.id} or ref_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`update tenants set candidates_enabled = false where slug = 'kappi'`
  await admin.end()
})

test('14. Воронка: рекрутинг включается тенанту, кандидат виден на доске и нанимается одной транзакцией', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)

  // Флаг тенанта: до него ручки воронки закрыты (§1, миграция 0056)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })

  const created = await api<{ id: string }>(request, csrf, 'post', '/candidates', {
    firstName: 'Марія', lastName: 'Воронкіна', phone: PHONE, consentGiven: true, commLanguage: 'uk',
  })
  await admin`update users set full_name = ${NAME} where id = ${created.id}`

  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/candidates')

  // Дошка: колонка «Не розпочали» со счётчиком и карточкой кандидата (§5.2)
  await expect(page.getByText('Не розпочали')).toBeVisible()
  await expect(page.getByRole('link', { name: NAME })).toBeVisible()

  await page.getByRole('link', { name: NAME }).click()
  await expect(page).toHaveURL(/\/admin\/candidates\/[0-9a-f-]+$/)

  // Найм (§5.5): точка, посада, дата виходу — обовʼязкові
  await page.getByRole('button', { name: /^Найняти$/ }).click()
  await page.getByLabel(/Точка/).selectOption({ index: 1 })
  await page.getByLabel(/Посада/).selectOption({ index: 1 })
  await page.getByLabel(/Дата виходу/).fill(new Date().toISOString().slice(0, 10))
  await page.locator('form').getByRole('button', { name: /^Найняти$/ }).click()
  await expect(page.getByText(/Кандидата найнято/)).toBeVisible()

  // Та сама запис users: вид змінився, друга людина не зʼявилась (§3.1, §7.6)
  const rows = await admin`select id, kind, candidate_state, status from users where phone = ${PHONE}`
  expect(rows.length).toBe(1)
  expect(rows[0]!.kind).toBe('employee')
  expect(rows[0]!.candidate_state).toBeNull()
  expect(rows[0]!.status).toBe('active')
  const [audit] = await admin`select action from audit_log where entity_id = ${created.id} and action = 'candidate.hired'`
  expect(audit).toBeDefined()

  // Найнятий зник з воронки: доска показує тільки тих, хто ще в відборі
  await page.goto('/admin/candidates')
  await expect(page.getByRole('link', { name: NAME })).toHaveCount(0)
})
