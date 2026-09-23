import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, cleanupCourses, loginViaUi, resetOtp } from './helpers'

/**
 * PR-23 пакета `docs/v2`: жалоба на материал глазами человека (`36-content-feedback.md`
 * §5.1, §5.2, §13 критерии 1, 2, 7).
 *
 * Здесь проверяется ровно то, чего не видит integration-тест: что кнопка есть на экране
 * прохождения, что форма — два тапа и ноль обязательных полей, что урок после отправки
 * не перезагружается, и что шестая жалоба за сутки блокируется **текстом**, а не молча.
 */

const PREFIX = 'E2E-ISSUE '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  await cleanupCourses(PREFIX)
  await admin`delete from content_issue_events where issue_id in (select id from content_issues where title like ${`${PREFIX}%`})`
  await admin`delete from content_reports where issue_id in (select id from content_issues where title like ${`${PREFIX}%`})`
  await admin`delete from content_issues where title like ${`${PREFIX}%`}`
  await admin`delete from content_reporter_stats where user_id in (select id from users where phone = ${EMPLOYEE_PHONE})`
  await admin.end()
})

test('Жалоба из урока: флажок у блока, два тапа, урок не перезагружается; шестая за сутки — текстом', async ({ page, request }) => {
  test.slow()
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Курс зі скаргою`, isCatalogVisible: true })
  const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Розділ' })
  await api(request, csrf, 'post', `/courses/${course.id}/lessons`, {
    moduleId: mod.id,
    title: `${PREFIX}Урок про станцію`,
    resource: { body: [{ id: 'b1', type: 'text', html: '<p>Текст із помилкою</p>' }] },
  })
  await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша версія' })

  // Прошлые прогоны не должны съедать суточный лимит этого (§7.10)
  await admin`delete from content_reports where user_id in (select id from users where phone = ${EMPLOYEE_PHONE})`
  await admin`delete from content_reporter_stats where user_id in (select id from users where phone = ${EMPLOYEE_PHONE})`

  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/catalog')
  await page.locator('.card', { hasText: `${PREFIX}Курс зі скаргою` }).getByRole('button', { name: /Детальніше/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Записатися/ }).click()
  await page.getByRole('link', { name: /Почати/ }).click()
  await expect(page.getByRole('heading', { name: `${PREFIX}Урок про станцію` })).toBeVisible()

  // Критерий 1: два тапа и ноль введённых символов — тип «Помилка в тексті» комментария не требует
  const flags = page.getByRole('button', { name: 'Повідомити про помилку' })
  await flags.last().click()
  const form = page.getByRole('dialog', { name: 'Що не так із матеріалом?' })
  await expect(form).toBeVisible()
  await expect(form.getByText(/Ми вже бачимо, де ти зараз/)).toBeVisible()
  await form.getByRole('button', { name: 'Помилка в тексті' }).click()
  await form.getByRole('button', { name: 'Надіслати' }).click()
  await expect(form.getByText('Дякуємо')).toBeVisible()

  // §5.2: возврат ровно туда, где человек был — урок остался на экране, ничего не перезагрузилось
  await expect(page.getByRole('heading', { name: `${PREFIX}Урок про станцію` })).toBeVisible()

  // Критерий 7: ещё четыре разных типа проходят, шестая жалоба — отказ текстом
  const csrfEmployee = (await page.context().cookies()).find(c => c.name === 'lola_csrf')!.value
  for (const issueType of ['unclear', 'outdated', 'broken_link', 'broken_file']) {
    await api(page.request, csrfEmployee, 'post', '/content-issues/reports', {
      targetType: 'lesson',
      targetId: (await admin`select id from lessons where title = ${`${PREFIX}Урок про станцію`} limit 1`)[0]!.id,
      issueType,
      source: 'lesson',
    })
  }

  await flags.last().click()
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Не працює посилання' }).click()
  await form.getByRole('button', { name: 'Надіслати' }).click()
  // Молчания нет: человек видит, почему форма не ушла, и что делать дальше
  await expect(form.getByRole('alert')).toHaveText(/Ти вже надіслав 5 повідомлень сьогодні/)
})
