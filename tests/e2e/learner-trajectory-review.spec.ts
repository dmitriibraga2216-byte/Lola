import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Шаг траектории, который выполняет не учащийся, а другой человек о нём (решение владельца продукта
 * 25.09.2026; docs/17 §5.2, docs/28 §28.21). Глазами учащегося: шаг «чек-лист» открыт, но нажимать
 * на нём нечего — статус «Очікує оцінки від керівника» и пояснение, кто и что сделает; на 320 px без
 * горизонтальной прокрутки. Чек-лист о нём заполнили (здесь — через API) — шаг засчитан сам, тем же
 * хуком результата, и следующий шаг открывается ссылкой.
 */

const PREFIX = 'E2E-TRJREV '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const trajIds = (await admin`select id from trajectories where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (trajIds.length) {
    await admin`delete from notifications where ref_type = 'trajectory_enrollment' and ref_id in (select id from trajectory_enrollments where trajectory_id in ${admin(trajIds)})`
    await admin`delete from assignments where audience->>'trajectoryId' in ${admin(trajIds)}`
    await admin`delete from trajectories where id in ${admin(trajIds)}`
  }
  const checklistIds = (await admin`select id from checklists where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  const quizIds = (await admin`select id from quizzes where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  const contentIds = [...checklistIds, ...quizIds]
  if (contentIds.length) {
    await admin`delete from task_status_log where content_id in ${admin(contentIds)}`
    await admin`delete from task_access_log where content_id in ${admin(contentIds)}`
  }
  if (checklistIds.length) { await admin`delete from checklist_runs where checklist_id in ${admin(checklistIds)}`; await admin`delete from checklists where id in ${admin(checklistIds)}` }
  if (quizIds.length) { await admin`delete from attempts where quiz_id in ${admin(quizIds)}`; await admin`delete from quizzes where id in ${admin(quizIds)}` }
  await admin`delete from questions where bank_id in (select id from question_banks where name like ${`${PREFIX}%`})`
  await admin`delete from question_banks where name like ${`${PREFIX}%`}`
  await admin.end()
})

test('Траєкторія «чек-лист → тест»: крок-чек-лист чекає на керівника без кнопки, після заповнення зараховується сам', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const checklistTitle = `${PREFIX}Зустріч гостя`
  const quizTitle = `${PREFIX}Тест зустрічі`
  const scales = await api<{ id: string, name: string }[]>(request, csrf, 'get', '/scales?kind=levels')
  const checklist = await api<{ id: string }>(request, csrf, 'put', '/checklists', {
    title: checklistTitle, kind: 'observation', subjectKind: 'user', scaleId: scales.find(s => s.name === '1–5')!.id, scoring: 'percent', passScore: 80, criticalFailRule: 'none', whoCanRun: { roles: ['manager', 'mentor'] },
    items: [{ id: 'greet', text: 'Вітається з гостем', weight: 1 }, { id: 'order', text: 'Звіряє замовлення', weight: 1 }],
  })
  const bank = await api<{ id: string }>(request, csrf, 'post', '/question-banks', { name: `${PREFIX}банк ${Date.now()}` })
  const question = await api<{ id: string }>(request, csrf, 'post', '/questions', { bankId: bank.id, kind: 'single', stem: [{ id: 's', type: 'text', html: '<p>Що кажемо гостю першим?</p>' }], options: [{ id: 'a', text: 'Вітаємось' }, { id: 'b', text: 'Мовчимо' }], answer: { correctId: 'a' }, points: 1 })
  const quiz = await api<{ id: string }>(request, csrf, 'post', '/quizzes', { title: quizTitle })
  await api(request, csrf, 'put', `/quizzes/${quiz.id}/questions`, { items: [{ questionId: question.id, sort: 0 }] })
  await api(request, csrf, 'patch', `/quizzes/${quiz.id}`, { status: 'published' })

  const trajectory = await api<{ id: string }>(request, csrf, 'post', '/trajectories', { title: `${PREFIX}Стажування бариста`, tags: [] })
  const g0 = await api<{ nodes: { id: string, kind: string }[] }>(request, csrf, 'get', `/trajectories/${trajectory.id}/graph`)
  const start = g0.nodes.find(n => n.kind === 'start')!.id, finish = g0.nodes.find(n => n.kind === 'finish')!.id
  const g = await api<{ ids: Record<string, string> }>(request, csrf, 'put', `/trajectories/${trajectory.id}/graph`, {
    nodes: [
      { id: start, kind: 'start', x: 0, y: 0 }, { id: finish, kind: 'finish', x: 600, y: 0 },
      { tmpId: 'tmp:check', kind: 'task', contentType: 'check_list', contentId: checklist.id, params: {}, x: 200, y: 0 },
      { tmpId: 'tmp:quiz', kind: 'task', contentType: 'test', contentId: quiz.id, params: { passScore: 50, attemptsAllowed: 0 }, x: 400, y: 0 },
    ],
    edges: [{ fromNodeId: start, toNodeId: 'tmp:check' }, { fromNodeId: 'tmp:check', toNodeId: 'tmp:quiz' }, { fromNodeId: 'tmp:quiz', toNodeId: finish }],
  })
  const checkNode = g.ids['tmp:check']!
  await api(request, csrf, 'post', `/trajectories/${trajectory.id}/publish`, {})
  const [employee] = await admin`select u.id from users u join tenants t on t.id = u.tenant_id where t.slug = 'kappi' and u.phone = ${EMPLOYEE_PHONE}`
  await api(request, csrf, 'post', `/trajectories/${trajectory.id}/audience`, { userIds: [employee!.id] })

  // Учащийся: шаг-чек-лист открыт, но ведёт его не он — статус ожидания и пояснение вместо кнопки
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/trajectories')
  await page.getByTestId(`traj-${trajectory.id}`).click()
  await expect(page).toHaveURL(/\/learn\/trajectories\/[0-9a-f-]{36}$/)
  const ladderUrl = page.url()
  await expect(page.getByText('Пройдено 0 з 2')).toBeVisible()
  await expect(page.getByTestId(`step-wait-${checkNode}`)).toHaveText('Очікує оцінки від керівника')
  await expect(page.getByText(/крок зарахується сам, щойно чек-лист надішлють/)).toBeVisible()
  const step = page.getByRole('listitem').filter({ hasText: checklistTitle })
  await expect(step.getByRole('link')).toHaveCount(0)
  await expect(step.getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('link', { name: quizTitle })).toHaveCount(0) // тест — после чек-листа
  // 320 px: без горизонтальной прокрутки, длинное пояснение переносится
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)

  // Чек-лист о нём заполнил другой человек (администратор — у него есть право проводить чек-листи)
  const run = await api<{ id: string }>(request, csrf, 'post', `/checklists/${checklist.id}/runs`, { subjectUserId: employee!.id })
  await api(request, csrf, 'post', `/checklist-runs/${run.id}/finish`, { answers: [{ itemId: 'greet', value: 5 }, { itemId: 'order', value: 5 }] })

  // Хук результата — после фиксации прогона («выстрелил и забыл»): ждём факт, а не время
  await expect(async () => {
    await page.goto(ladderUrl)
    await expect(page.getByText('Пройдено 1 з 2')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(page.getByText('Чек-лист · виконано 100%')).toBeVisible()
  await expect(page.getByTestId(`step-wait-${checkNode}`)).toHaveCount(0)
  // Следующий шаг открылся ссылкой на экран теста — с клавиатуры
  const next = page.getByRole('link', { name: quizTitle })
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/learn/quiz/${quiz.id}`))
})
