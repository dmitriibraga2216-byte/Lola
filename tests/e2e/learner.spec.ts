import { expect, test } from '@playwright/test'
import { ADMIN_PHONE, EMPLOYEE_PHONE, MENTOR_PHONE, api, apiLogin, cleanupCourses, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E '

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await cleanupCourses(PREFIX)
})

test('1. Вход по OTP за два экрана; неверный код показывает остаток попыток', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Lola' })).toBeVisible()
  const responsePromise = page.waitForResponse(r => r.url().includes('/auth/otp/request'))
  await page.getByPlaceholder('__ ___ __ __').fill(EMPLOYEE_PHONE.replace('+380', ''))
  await page.getByRole('button', { name: /Отримати код/ }).click()
  const { data } = await (await responsePromise).json() as { data: { devCode: string } }
  await expect(page.getByText(/Код надіслали/)).toBeVisible()

  await page.getByLabel('Введіть код').fill(data.devCode === '000000' ? '000001' : '000000')
  await expect(page.getByText(/Код невірний. Залишилось 4/)).toBeVisible()

  await page.getByLabel('Введіть код').fill(data.devCode)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText(/Ви увійшли як/)).toBeVisible()
})

test('2. Прохождение урока с телефона: закрыть на втором уроке, вернуться — открывается второй', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Гарячий цех`, isCatalogVisible: true })
  const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Основи' })
  for (const n of [1, 2, 3]) {
    await api(request, csrf, 'post', `/courses/${course.id}/lessons`, {
      moduleId: mod.id, title: `Урок ${n}`,
      resource: { body: [{ id: `t${n}`, type: 'text', html: `<p>Зміст уроку ${n}</p>` }, { id: `c${n}`, type: 'checklist', items: ['Прочитав'], requireAll: true }] },
    })
  }
  await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша версія' })

  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/catalog')
  await page.getByRole('button', { name: /Записатися/ }).first().click()
  await expect(page).toHaveURL(/\/learn\/[0-9a-f-]+$/)
  await expect(page.getByText(/Пройдено 0 з 3/)).toBeVisible()

  await page.getByRole('link', { name: /Почати/ }).click()
  await expect(page.getByText('Урок 1 з 3')).toBeVisible()
  const next = page.getByRole('button', { name: /Далі/ })
  await expect(next).toBeDisabled()
  await expect(page.getByText('Познач усі пункти')).toBeVisible()
  await page.getByRole('checkbox').check()
  await expect(next).toBeEnabled()
  await next.click()
  await expect(page.getByText('Урок 2 з 3')).toBeVisible()

  // «Закрыл вкладку» — уходим и возвращаемся
  await page.goto('/learn')
  await expect(page.getByText(/Продовжити/)).toBeVisible()
  await page.getByRole('link', { name: /Продовжити/ }).first().click()
  await expect(page.getByText(/Пройдено 1 з 3/)).toBeVisible()
  await page.getByRole('link', { name: /Продовжити/ }).click()
  await expect(page.getByText('Урок 2 з 3')).toBeVisible()
})

test('3. Тест с ручной проверкой: ученик сдаёт → «На перевірці» → наставник зачитывает → разбор виден', async ({ page, request, browser }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const bank = await api<{ id: string }>(request, csrf, 'post', '/question-banks', { name: `${PREFIX}банк ${Date.now()}` })
  const q1 = await api<{ id: string }>(request, csrf, 'post', '/questions', { bankId: bank.id, kind: 'single', stem: [{ id: 's', type: 'text', html: '<p>Температура риби?</p>' }], options: [{ id: 'a', text: '0…+4' }, { id: 'b', text: '+10' }], answer: { correctId: 'a' }, points: 1 })
  const q2 = await api<{ id: string }>(request, csrf, 'post', '/questions', { bankId: bank.id, kind: 'text_long', stem: [{ id: 's', type: 'text', html: '<p>Що зробиш, якщо гість каже, що піца холодна?</p>' }], answer: { criteria: ['Вибачення'] }, points: 1 })
  // Правил прохождения у теста нет (CLAUDE.md п. 11): порог — в плане курса, остальное — умолчания тенанта
  const quiz = await api<{ id: string }>(request, csrf, 'post', '/quizzes', { title: `${PREFIX}тест` })
  await api(request, csrf, 'put', `/quizzes/${quiz.id}/questions`, { items: [{ questionId: q1.id, sort: 0 }, { questionId: q2.id, sort: 1 }] })
  await api(request, csrf, 'patch', `/quizzes/${quiz.id}`, { status: 'published' })
  const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Курс з тестом`, isCatalogVisible: true })
  const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Р' })
  await api(request, csrf, 'post', `/courses/${course.id}/lessons`, { moduleId: mod.id, title: 'Фінальний тест', itemType: 'quiz', quizId: quiz.id, passScorePct: 50 })
  await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша версія' })

  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/catalog')
  await page.getByText(`${PREFIX}Курс з тестом`).locator('..').getByRole('button', { name: /Записатися/ }).click()
  await page.getByRole('link', { name: /Почати/ }).click()
  await expect(page.getByRole('heading', { name: `${PREFIX}тест` })).toBeVisible()
  await page.getByRole('button', { name: /^Почати$/ }).click()
  // Порядок вопросов перемешан умолчаниями — отвечаем по типу вопроса, а не по позиции
  for (let i = 0; i < 2; i++) {
    await expect(page.getByText(`Питання ${i + 1} з 2`)).toBeVisible()
    const option = page.getByRole('button', { name: '0…+4' })
    if (await option.isVisible()) await option.click()
    else await page.getByRole('textbox').fill('Вибачусь і заміню піцу за рахунок закладу')
    await page.getByRole('button', { name: i === 0 ? /Далі/ : /Надіслати/ }).click()
  }
  await expect(page.getByText('На перевірці')).toBeVisible()

  // Наставник: очередь показывает работу, зачёт — через тот же API, что кнопка (UI очереди покрыт отдельно)
  const mentorCtx = await browser.newContext()
  const mp = await mentorCtx.newPage()
  await resetOtp()
  await loginViaUi(mp, MENTOR_PHONE)
  await mp.goto('/admin/review')
  await expect(mp.getByText(/Залишилось \d+/)).toBeVisible()
  const queue = await api<{ answerId: string, question: { stem: { html: string }[] } }[]>(mp.request, (await mp.context().cookies()).find(c => c.name === 'lola_csrf')!.value, 'get', '/review/queue')
  const ours = queue.find(i => JSON.stringify(i.question.stem).includes('гість каже'))!
  expect(ours).toBeDefined()
  await api(mp.request, (await mp.context().cookies()).find(c => c.name === 'lola_csrf')!.value, 'post', `/review/answers/${ours.answerId}/grade`, { isCorrect: true, comment: 'Добре' })
  await mentorCtx.close()

  // Ученик видит результат и разбор
  await page.goto('/learn?tab=done')
  await page.getByRole('tab', { name: /Завершені/ }).click()
  await page.locator('.card', { hasText: `${PREFIX}Курс з тестом` }).click()
  await expect(page.getByText('Завершено', { exact: true })).toBeVisible()
  // Разбор доступен ученику по API результата (show_answers=after_attempt)
  const attempts = await api<{ history: { id: string, passed: boolean }[] }>(page.request, (await page.context().cookies()).find(c => c.name === 'lola_csrf')!.value, 'get', `/learning/quizzes/${quiz.id}`)
  expect(attempts.history[0]!.passed).toBe(true)
  const result = await api<{ score: number, questions: { reviewComment: string | null, answer?: unknown }[] }>(page.request, '', 'get', `/attempts/${attempts.history[0]!.id}/result`)
  expect(result.score).toBe(100)
  expect(result.questions.some(q => q.reviewComment === 'Добре')).toBe(true)
  expect(result.questions.every(q => 'answer' in q)).toBe(true)
})

test('4. Каталог: записанный курс показан один раз с бейджем', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Каталог`, isCatalogVisible: true })
  const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Р' })
  await api(request, csrf, 'post', `/courses/${course.id}/lessons`, { moduleId: mod.id, title: 'У', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] } })
  await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша версія' })

  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/learn/catalog')
  const card = page.locator('.card', { hasText: `${PREFIX}Каталог` })
  await card.getByRole('button', { name: /Записатися/ }).click()
  await page.goto('/learn/catalog')
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('link', { name: /Вже призначено/ })).toBeVisible()
})
