import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-15 (docs/v2/29-vacancies.md §13 к. 1 и к. 8, §4, §5.2, Г-29.2).
 *
 * Проверяется то, что видно на экране, а не только в сервисе:
 * 1. вакансия без курса не публикуется — приходит «Оберіть курс і точку…», состояние
 *    остаётся чернеткой (к. 1);
 * 2. после выбора курса и точки публикация даёт публичную ссылку;
 * 3. правка параметров показывает «Зміни вплинуть лише на нові відгуки. Кандидатів у
 *    роботі: 1» и **не трогает** уже созданное назначение (к. 8) — назначение сверяется в БД
 *    поле в поле.
 *
 * Флаг `candidates_enabled` здесь не декорация: без него раздела нет в меню. Сценарий
 * включает его и возвращает обратно — соседние сценарии не должны видеть чужой раздел.
 */

const TITLE = 'E2E Вакансія бариста'
const PHONE = '+380679960001'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const people = await admin`select id from users where phone = ${PHONE}`
  for (const r of people) {
    await admin`delete from enrollments where user_id = ${r.id}`
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`update users set vacancy_id = null where id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from assignments where title = ${TITLE}`
  const vs = await admin`select id from vacancies where title = ${TITLE}`
  for (const v of vs) {
    await admin`delete from audit_log where entity_id = ${v.id}`
    await admin`delete from vacancies where id = ${v.id}`
  }
  await admin`update tenants set candidates_enabled = false where slug = 'kappi'`
  await admin.end()
})

test('15. Вакансія: без курсу не публікується, після публікації дає посилання, правка не чіпає створеного призначення', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })

  const vacancy = await api<{ id: string }>(request, csrf, 'post', '/vacancies', { title: TITLE })

  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/vacancies/${vacancy.id}`)
  await expect(page.getByText('Чернетка')).toBeVisible()

  // §13 к. 1: публикация без курса и точки — отказ с объяснением, состояние не изменилось.
  await page.getByRole('button', { name: 'Опублікувати' }).click()
  await expect(page.getByText(/Оберіть курс і точку/)).toBeVisible()
  await expect(page.getByText('Чернетка')).toBeVisible()

  // Курс и точка — и та же кнопка публикует.
  await page.getByLabel('Рекрутинговий курс').selectOption({ index: 1 })
  await page.getByLabel('Точка').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click()
  await expect(page.getByText(/Зміни вплинуть лише на нові відгуки/)).toBeVisible()
  await page.getByRole('button', { name: 'Опублікувати' }).click()
  await expect(page.getByText('Опублікована')).toBeVisible()
  await expect(page.getByText(/Посилання на відбір/)).toBeVisible()

  const [row] = await admin`select public_token, public_enabled, course_id from vacancies where id = ${vacancy.id}`
  expect(String(row!.public_token)).toHaveLength(22)
  expect(row!.public_enabled).toBe(true)

  // §13 к. 8: кандидат в работе с назначением по шаблону вакансии.
  const candidate = await api<{ id: string }>(request, csrf, 'post', '/candidates', {
    firstName: 'Оксана', lastName: 'Відгукнулась', phone: PHONE, consentGiven: true, commLanguage: 'uk', vacancyId: vacancy.id,
  })
  await api(request, csrf, 'post', '/tasks', {
    title: TITLE,
    subjectType: 'course',
    subjectId: String(row!.course_id),
    audience: { rules: [{ type: 'user', ids: [candidate.id] }], match: 'any' },
    dueMode: 'relative',
    dueDays: 3,
    params: { passScore: 70 },
  })
  const [before] = await admin`select params, due_days from assignments where title = ${TITLE}`

  await page.reload()
  await expect(page.getByText('Кандидатів у роботі: 1')).toBeVisible()
  await page.getByLabel('Поріг проходження, %').fill('95')
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click()
  await expect(page.getByText('Зміни вплинуть лише на нові відгуки. Кандидатів у роботі: 1')).toBeVisible()

  // Назначение не изменилось ни в одном поле — правка вакансии его не касается.
  const [after] = await admin`select params, due_days from assignments where title = ${TITLE}`
  expect(after).toEqual(before)
  expect((after!.params as Record<string, unknown>).passScore).toBe(70)
})
