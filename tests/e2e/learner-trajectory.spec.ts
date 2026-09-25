import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * fix-resource-node (docs/11 Г-11.5, docs/17 §5.2, §14.3): учащийся проходит траекторию, где есть
 * шаг-материал. До исправления шаг вёл в «Мої завдання» (там только курсы), а просмотр материала
 * узел не засчитывал — траектория не завершалась никогда. Здесь — глазами учащегося: лента →
 * материал по назначению узла → дочитать (время чтения считает сервер) → «Завершити» с клавиатуры →
 * снова лента, шаг зачтён → следующий шаг (тест) открывается ссылкой → траектория пройдена.
 */

const PREFIX = 'E2E-TRAJ '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const trajIds = (await admin`select id from trajectories where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (trajIds.length) {
    await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`
    await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`
    await admin`delete from trajectories where id in ${admin(trajIds)}`
  }
  const resourceIds = (await admin`select id from resources where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  const quizIds = (await admin`select id from quizzes where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  const contentIds = [...resourceIds, ...quizIds]
  if (contentIds.length) {
    await admin`delete from task_status_log where content_id in ${admin(contentIds)}`
    await admin`delete from task_access_log where content_id in ${admin(contentIds)}`
  }
  if (resourceIds.length) await admin`delete from resources where id in ${admin(resourceIds)}`
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id in (select id from question_banks where name like ${`${PREFIX}%`})`
  await admin`delete from question_banks where name like ${`${PREFIX}%`}`
  await admin.end()
})

test('Траєкторія «матеріал → тест»: крок-матеріал відкривається зі стрічки, зараховується після читання, траєкторію пройдено', async ({ page, request }) => {
  test.slow() // ждём минимальное время чтения страницы (Г-11.5, 20 с) — решает сервер по тикам
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const resourceTitle = `${PREFIX}Стандарт видачі`
  const quizTitle = `${PREFIX}Тест видачі`
  const resource = await api<{ id: string }>(request, csrf, 'post', '/resources', {
    kind: 'article', title: resourceTitle,
    body: [{ id: 'b1', type: 'text', html: '<p>Перед видачею звіряємо номер замовлення на чеку і на пакеті.</p>' }],
  })
  await api(request, csrf, 'post', `/resources/${resource.id}/publish`, { notifyAssigned: false })
  const bank = await api<{ id: string }>(request, csrf, 'post', '/question-banks', { name: `${PREFIX}банк ${Date.now()}` })
  const question = await api<{ id: string }>(request, csrf, 'post', '/questions', { bankId: bank.id, kind: 'single', stem: [{ id: 's', type: 'text', html: '<p>Що робимо перед видачею?</p>' }], options: [{ id: 'a', text: 'Звіряємо номер' }, { id: 'b', text: 'Віддаємо одразу' }], answer: { correctId: 'a' }, points: 1 })
  const quiz = await api<{ id: string }>(request, csrf, 'post', '/quizzes', { title: quizTitle })
  await api(request, csrf, 'put', `/quizzes/${quiz.id}/questions`, { items: [{ questionId: question.id, sort: 0 }] })
  await api(request, csrf, 'patch', `/quizzes/${quiz.id}`, { status: 'published' })

  const trajectory = await api<{ id: string }>(request, csrf, 'post', '/trajectories', { title: `${PREFIX}Видача замовлень`, tags: [] })
  const g0 = await api<{ nodes: { id: string, kind: string }[] }>(request, csrf, 'get', `/trajectories/${trajectory.id}/graph`)
  const start = g0.nodes.find(n => n.kind === 'start')!.id, finish = g0.nodes.find(n => n.kind === 'finish')!.id
  await api(request, csrf, 'put', `/trajectories/${trajectory.id}/graph`, {
    nodes: [
      { id: start, kind: 'start', x: 0, y: 0 }, { id: finish, kind: 'finish', x: 600, y: 0 },
      { tmpId: 'tmp:res', kind: 'task', contentType: 'resource', contentId: resource.id, params: {}, x: 200, y: 0 },
      { tmpId: 'tmp:quiz', kind: 'task', contentType: 'test', contentId: quiz.id, params: { passScore: 50, attemptsAllowed: 0 }, x: 400, y: 0 },
    ],
    edges: [{ fromNodeId: start, toNodeId: 'tmp:res' }, { fromNodeId: 'tmp:res', toNodeId: 'tmp:quiz' }, { fromNodeId: 'tmp:quiz', toNodeId: finish }],
  })
  await api(request, csrf, 'post', `/trajectories/${trajectory.id}/publish`, {})
  const [employee] = await admin`select u.id from users u join tenants t on t.id = u.tenant_id where t.slug = 'kappi' and u.phone = ${EMPLOYEE_PHONE}`
  await api(request, csrf, 'post', `/trajectories/${trajectory.id}/audience`, { userIds: [employee!.id] })

  // Учащийся: лента траектории → шаг-материал ведёт на экран прохождения материала
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/trajectories')
  await page.getByTestId(`traj-${trajectory.id}`).click()
  await expect(page).toHaveURL(/\/learn\/trajectories\/[0-9a-f-]{36}$/)
  await expect(page.getByText('Пройдено 0 з 2')).toBeVisible()
  const ladderUrl = page.url()
  await page.getByRole('link', { name: resourceTitle }).click()
  await expect(page).toHaveURL(new RegExp(`/learn/resources/${resource.id}\\?assignmentId=[0-9a-f-]+$`))
  await expect(page.getByRole('heading', { name: resourceTitle })).toBeVisible()

  // Открытия мало (Г-11.5): «Завершити» неактивна, подпись объясняет, чего ждать
  const complete = page.getByRole('button', { name: 'Завершити' })
  await expect(complete).toBeDisabled()
  await expect(page.getByText(/Ще \d+ секунд до зарахування/)).toBeVisible()
  // Экран работает на 320px — без горизонтальной прокрутки
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)

  await expect(complete).toBeEnabled({ timeout: 45_000 })
  // С клавиатуры: фокус на кнопке, Enter
  await complete.focus()
  await page.keyboard.press('Enter')

  // Сервер зачёл материал и сам сдвинул траекторию — человек снова в ленте, шаг отмечен
  await expect(page).toHaveURL(ladderUrl)
  await expect(page.getByText('Пройдено 1 з 2')).toBeVisible()
  await expect(page.getByText('Ресурс · виконано')).toBeVisible()

  // Следующий шаг — тест: ссылка из ленты на экран теста, а не в «Мої завдання»
  await page.getByRole('link', { name: quizTitle }).click()
  await expect(page).toHaveURL(new RegExp(`/learn/quiz/${quiz.id}`))
  await page.getByRole('button', { name: /^Почати$/ }).click()
  await page.getByRole('button', { name: 'Звіряємо номер' }).click()
  await page.getByRole('button', { name: /Надіслати/ }).click()
  await expect(page.getByText('Зараховано', { exact: true })).toBeVisible()

  // Хук теста срабатывает после фиксации попытки («выстрелил и забыл») — ждём факт, а не время
  await expect(async () => {
    await page.goto(ladderUrl)
    await expect(page.getByText('Пройдено 2 з 2')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(page.getByText('Виконано', { exact: true })).toBeVisible()
})
