import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Хвосты блока «Кандидаты» (docs/v2/28 §5.3, §7.9, §10): вкладка «Проходження» с пустым
 * состоянием и кнопкой назначения, удаление по праву на забвение — на 320 px и без
 * горизонтальной прокрутки страницы.
 */

const PHONE = '+380679950002'
const NAME = 'E2E Кандидат Хвости'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

let createdId: string | null = null

test.beforeEach(resetOtp)

test.afterAll(async () => {
  // Обезличенный кандидат теряет и телефон, и ФИО — поэтому ещё и по запомненному id
  const rows = await admin`select id from users where phone = ${PHONE} or full_name = ${NAME} or id = ${createdId ?? '00000000-0000-0000-0000-000000000000'}`
  for (const r of rows) {
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from candidate_comments where candidate_id = ${r.id}`
    await admin`delete from notifications where user_id = ${r.id} or ref_id = ${r.id}`
    await admin`delete from invitations where user_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`update tenants set candidates_enabled = false where slug = 'kappi'`
  await admin.end()
})

test('28. Картка кандидата: «Проходження» порожнє з кнопкою, видалення знеособлює дані (320 px)', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })
  const created = await api<{ id: string }>(request, csrf, 'post', '/candidates', {
    firstName: 'Олена', lastName: 'Хвостенко', phone: PHONE, consentGiven: true, commLanguage: 'uk',
  })
  createdId = created.id
  await admin`update users set full_name = ${NAME} where id = ${created.id}`

  await page.setViewportSize({ width: 320, height: 720 })
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/candidates/${created.id}`)
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible()

  await page.getByRole('tab', { name: 'Проходження' }).click()
  await expect(page.getByText('Кандидату ще нічого не призначено')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Призначити контент' })).toHaveAttribute('href', `/admin/assignments/new?candidateId=${created.id}`)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  await page.getByRole('button', { name: /^Видалити$/ }).click()
  await page.getByLabel('Причина видалення').fill('запит субʼєкта даних')
  await page.getByRole('button', { name: 'Видалити назавжди' }).click()
  await expect(page.getByText('Дані кандидата знеособлено')).toBeVisible()

  const [row] = await admin`select full_name, phone, candidate_state from users where id = ${created.id}`
  expect(row!.full_name).toBe(`Кандидат №${created.id.slice(0, 8)}`)
  expect(row!.phone).toBeNull()
  expect(row!.candidate_state).toBe('archived')
})
