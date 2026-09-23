import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, MENTOR_PHONE, api, apiLogin, cleanupCourses, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-admin '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await cleanupCourses(PREFIX)
  await admin`delete from users where full_name like 'E2E Імпорт%'`
  const ws = (await admin`select id from workshops where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (ws.length) {
    await admin`delete from review_queue_items where task_type = 'workshop' and source_id in (select id from workshop_submissions where workshop_id in ${admin(ws)})`
    await admin`delete from workshop_submissions where workshop_id in ${admin(ws)}`
    await admin`delete from workshops where id in ${admin(ws)}`
  }
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
  // Мокап Import: та сама помилка тепер видна і в таблиці рядків, і в бічній картці «Помилки в рядках» — .first()
  await expect(page.getByText(/Телефон: невірний формат/).first()).toBeVisible()
  await expect(page.getByText(/ПІБ: обовʼязкове/).first()).toBeVisible()
  await page.getByRole('button', { name: /Застосувати \(1\)/ }).click()
  await expect(page.getByText(/створено 1, оновлено 0/)).toBeVisible()
  await expect(page.getByRole('link', { name: /Завантажити звіт/ })).toBeVisible()
})

test('8. Доступ: employee не открывает админку ни по ссылке, ни по API', async ({ page, request }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/admin/people')
  await expect(page).toHaveURL(/\/learn$/) // гард увёл на главную, корень — в кабинет
  await expect(page.getByRole('link', { name: 'Управління' })).toHaveCount(0)

  await apiLogin(request, EMPLOYEE_PHONE)
  for (const path of ['/api/v1/people', '/api/v1/courses', '/api/v1/assignments', '/api/v1/audit']) {
    const res = await request.get(path)
    expect(res.status(), path).toBe(403)
  }
})

/**
 * Критерий приёмки docs/v2/37 §13 п. 6 на экране (PR-18): наставник — автор материала.
 * Карточка предупреждает жёлтой плашкой, но решение ему **разрешено** — кнопки активны,
 * а факт проверки автором уходит в `audit_log` (основание отчёта `37` §9.2).
 */
test('9. Очередь проверки: автор материала предупреждён, но решает; работа уходит из очереди', async ({ page, request, browser }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const workshop = await api<{ id: string }>(request, csrf, 'post', '/workshops', {
    title: `${PREFIX}Практикум автора`,
    description: [{ id: 'b1', type: 'text', html: '<p>Зберіть сет за чек-листом</p>' }],
    submissionKinds: ['text'], minTextLength: 10,
    criteria: [{ text: 'Дотримано температуру' }],
    reviewerRule: 'any_mentor', slaHours: 48, status: 'published',
  })
  // Автор материала — наставник: `author_ids` проставляется создателем, здесь он подменяется
  // напрямую, потому что права методиста наставнику не выдаются (docs/v2/37 §7.8).
  const [mentor] = await admin`select id from users where phone = ${MENTOR_PHONE}`
  await admin`update workshops set author_ids = array[${mentor!.id}]::uuid[] where id = ${workshop.id}`

  const learnerCtx = await browser.newContext()
  const lp = await learnerCtx.newPage()
  await resetOtp()
  await loginViaUi(lp, EMPLOYEE_PHONE)
  const learnerCsrf = (await lp.context().cookies()).find(c => c.name === 'lola_csrf')!.value
  await api(lp.request, learnerCsrf, 'post', `/learning/workshops/${workshop.id}/submit`, { text: 'Зібрав за чек-листом, температура +2' })
  await learnerCtx.close()

  await resetOtp()
  await loginViaUi(page, MENTOR_PHONE)
  await page.goto('/admin/review-workshops')
  await page.locator('.row', { hasText: 'Практикум автора' }).getByRole('button').click()

  await expect(page.getByText('Ви автор цього матеріалу')).toBeVisible()
  // `exact: true` — иначе имя совпадает и с «Не зараховано» (подстрока).
  const accept = page.getByRole('button', { name: 'Зараховано', exact: true })
  // Правило зачёта по умолчанию — «всі критерії»: кнопка оживает после отметки критерия.
  // Плашка автора её не блокирует — в этом и критерий 6, в отличие от своей работы.
  await page.locator('.crit-row input[type="checkbox"]').first().check()
  await expect(accept).toBeEnabled()
  const graded = page.waitForResponse(r => r.url().includes('/grade') && r.request().method() === 'POST')
  await accept.click()
  const res = await graded
  expect(res.status(), await res.text()).toBe(200)

  // Решение принято: экран вернулся к списку и работы в нём больше нет.
  await expect(page.locator('.error')).toHaveCount(0)
  await expect(page.locator('.row', { hasText: 'Практикум автора' })).toHaveCount(0)

  const mentorCsrf = (await page.context().cookies()).find(c => c.name === 'lola_csrf')!.value
  const done = await api<{ items: { taskTitle: string, status: string }[], total: number }>(page.request, mentorCsrf, 'get', '/review/queue?tab=done&taskType=workshop')
  const rows = await admin`select status, task_title, completed_at from review_queue_items where task_title = ${`${PREFIX}Практикум автора`}`
  expect(done.items.some(i => i.taskTitle === `${PREFIX}Практикум автора`), `строки очереди в БД: ${JSON.stringify(rows)}; ответ: ${JSON.stringify(done.items)}`).toBe(true)
  const [log] = await admin`select id from audit_log where action = 'review.author_conflict' and actor_id = ${mentor!.id} order by created_at desc limit 1`
  expect(log, 'факт проверки автором не записан').toBeDefined()
})
