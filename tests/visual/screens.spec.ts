import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import postgres from 'postgres'
import { extractMockupTexts } from '../../scripts/mockupText'
import { ADMIN_PHONE, api, apiLogin, EMPLOYEE_PHONE, loginViaUi, requestOtp, resetOtp } from '../e2e/helpers'

/**
 * Визуальные тесты по мокапам (docs/28 «visual-mockups», docs/32 §Б строка 21).
 *
 * Два независимых сигнала на экран, оба логируются, ни один не проваливает CI (шаг в
 * ci.yml идёт с continue-on-error — расхождения складываются в список долгов, не блокируют
 * мердж):
 *  1. Скриншот приложения против эталона из мокапа (`pnpm visual:mockups`), не пиксель-в-
 *     пиксель — экраны разные, поэтому порог MAX_DIFF_PIXEL_RATIO нарочно широкий (см. docs/28).
 *  2. Структурная проверка: заметные тексты мокапа (extractMockupTexts) должны быть видны на
 *     реальном экране. Это основной, более надёжный сигнал — падение здесь и есть конкретное
 *     расхождение (не найден заголовок/кнопка/чип), а не «картинка не похожа».
 */

const MOCKUPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/mockups/screens')
const MAX_DIFF_PIXEL_RATIO = 0.5

const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

function mockupTexts(name: string): string[] {
  return extractMockupTexts(readFileSync(path.join(MOCKUPS_DIR, `${name}.html`), 'utf-8'))
}

/** Отключаем анимации/каретку — иначе скриншот ловит случайный кадр перехода (docs/28). */
async function stabilize(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }`,
  })
}

/** Маскируем аватары/даты/«приглушённые» ячейки (имена, «Створено») — они разные при каждом прогоне. */
function commonMask(page: Page) {
  return [page.locator('.avatar'), page.locator('td.muted'), page.locator('.meta'), page.locator('time')]
}

/**
 * Структурная проверка: печатает список ненайденных текстов в консоль (собирается CI-шагом в
 * $GITHUB_STEP_SUMMARY) и помечает тест аннотацией mockup-gap для json-отчёта; текст мокапа
 * ищем без учёта регистра (капслок-чипы в приложении часто задаются text-transform, а не
 * буквами) — toBeVisible тут не годится, getByText сам нормализует регистр и пробелы.
 */
async function checkStructure(page: Page, screen: string, texts: string[], ignore: string[] = []) {
  const missing: string[] = []
  for (const txt of texts) {
    if (ignore.includes(txt)) continue
    const count = await page.getByText(txt, { exact: false }).count()
    if (count === 0) missing.push(txt)
  }
  test.info().annotations.push({ type: 'mockup-gap', description: JSON.stringify({ screen, expected: texts.length, missing }) })
  if (missing.length) console.log(`[visual] ${screen}: не знайдено на екрані — ${missing.join(' | ')}`)
  else console.log(`[visual] ${screen}: усі ${texts.length} текстів мокапу знайдені`)
  expect.soft(missing, `Розбіжності з мокапом «${screen}»`).toEqual([])
}

test.beforeEach(resetOtp)

// ---------------------------------------------------------------------------------------------
// Main (/admin/assignments) + TaskCard (/admin/assignments/:id) — десктоп, один набор данных
// ---------------------------------------------------------------------------------------------
test.describe('Main + TaskCard', () => {
  const PREFIX = 'E2E-visual-main '
  let assignmentId = ''

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'desktop') return // Main/TaskCard — тільки адмінка, не готувати фікстуру двічі
    await resetOtp()
    const { csrf } = await apiLogin(request, ADMIN_PHONE)
    // docs/33 D-067: мокап TaskCard.html показує ТЕСТ («Тест «Касова дисципліна на ТТ» · 12 питань»),
    // а не курс — фікстура була на курсі. Назва квізу — дослівно приклад з мокапа.
    const bank = await api<{ id: string }>(request, csrf, 'post', '/question-banks', { name: `${PREFIX}банк` })
    const questionIds: string[] = []
    for (let i = 0; i < 12; i++) {
      const q = await api<{ id: string }>(request, csrf, 'post', '/questions', {
        bankId: bank.id, kind: 'single', stem: [{ id: 's', type: 'text', html: `<p>Питання ${i + 1}</p>` }],
        options: [{ id: 'a', text: 'Так' }, { id: 'b', text: 'Ні' }], answer: { correctId: 'a' }, points: 1,
      })
      questionIds.push(q.id)
    }
    const quiz = await api<{ id: string }>(request, csrf, 'post', '/quizzes', { title: `${PREFIX}Тест «Касова дисципліна на ТТ»` })
    await api(request, csrf, 'put', `/quizzes/${quiz.id}/questions`, { items: questionIds.map((questionId, sort) => ({ questionId, sort })) })
    await api(request, csrf, 'patch', `/quizzes/${quiz.id}`, { status: 'published' })
    const [emp] = await admin`select id from users where phone = ${EMPLOYEE_PHONE}`
    const created = await api<{ assignmentId: string }>(request, csrf, 'post', '/tasks', {
      subjectType: 'test',
      subjectId: quiz.id,
      audience: { rules: [{ type: 'user', ids: [emp!.id as string] }], match: 'any' },
      dueMode: 'relative',
      dueDays: 14,
    })
    assignmentId = created.assignmentId // POST /tasks отдаёт { ok, assignmentId, expanded }
  })

  test.afterAll(async () => {
    await admin`delete from assignments where subject_id in (select id from quizzes where title like ${`${PREFIX}%`})`
    await admin`delete from quizzes where title like ${`${PREFIX}%`}`
    await admin`delete from question_banks where name like ${`${PREFIX}%`}`
  })

  test('Main: /admin/assignments', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'адмінка — тільки desktop')
    await loginViaUi(page, ADMIN_PHONE)
    await page.goto('/admin/assignments')
    await expect(page.getByRole('heading', { name: /Завдання/ })).toBeVisible()
    await stabilize(page)
    // «БД» — ініціали адміністратора в мокапі (Брага Дмитро, приклад людини картки внизу
    // меню, docs/31 шапка) — не переноситься; у бойовому тенанті свій адміністратор
    await checkStructure(page, 'Main', mockupTexts('Main'), ['БД'])
    await expect(page).toHaveScreenshot(`Main-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: commonMask(page), animations: 'disabled' })
  })

  test('TaskCard: /admin/assignments/:id', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'адмінка — тільки desktop')
    await loginViaUi(page, ADMIN_PHONE)
    await page.goto(`/admin/assignments/${assignmentId}`)
    await expect(page).toHaveURL(new RegExp(assignmentId))
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Касова дисципліна') // карточка грузится клиентом
    await stabilize(page)
    await checkStructure(page, 'TaskCard', mockupTexts('TaskCard'), ['БД'])
    await expect(page).toHaveScreenshot(`TaskCard-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: commonMask(page), animations: 'disabled' })
  })
})

// ---------------------------------------------------------------------------------------------
// Login — мобильный, шаг телефона и шаг кода. Мокап Login.html есть только для шага кода
// (docs/31 — второго мокапа для шага телефона нет), поэтому шаг телефона проверяется только
// структурно (общими элементами — брендовое имя, футер поддержки), без сравнения скриншота.
// ---------------------------------------------------------------------------------------------
test.describe('Login', () => {
  test('Login: /login — крок телефону', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await page.goto('/login')
    await stabilize(page)
    // Мокапа шага телефона нет — проверяем общие для обоих шагов элементы (докладнее — docs/28)
    await checkStructure(page, 'Login (крок телефону)', ['Отримати код'])
  })

  test('Login: /login — крок коду', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await requestOtp(page, ADMIN_PHONE)
    await stabilize(page)
    await checkStructure(page, 'Login', mockupTexts('Login'))
    await expect(page).toHaveScreenshot(`Login-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: [page.locator('.phone-b'), page.locator('.demo-code')], animations: 'disabled' })
  })
})

// ---------------------------------------------------------------------------------------------
// Learn home (MyTasks) + Profile — мобильный, кабинет сотрудника
// ---------------------------------------------------------------------------------------------
test.describe('Learn home + Profile', () => {
  const MT_PREFIX = 'E2E-visual-mytasks '

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'mobile') return // MyTasks — тільки кабінет, не готувати фікстуру двічі
    await resetOtp()
    const { csrf } = await apiLogin(request, ADMIN_PHONE)
    const [emp] = await admin`select id from users where phone = ${EMPLOYEE_PHONE}`
    // docs/33 D-067: одна фікстура (курс на 14 днів, з описом «Main + TaskCard») заповнювала лише
    // групу «Пізніше» — додаємо курс на 3 дні («Цього тижня»). Групу «Прострочено» додати сюди
    // не можна: `taskGroupWhere('overdue')` (server/services/enrollmentStatus.ts) — окрема від
    // new/planned/failed група, а вкладка «active» на /learn (app/pages/learn/index.vue)
    // запитує лише new/planned/failed — прострочені картки живуть на окремій вкладці «Прострочено»
    // і на екрані «active»-вкладки їх принципово не буває; мокап показує всі три секції разом —
    // розбіжність мокапу з поведінкою застосунку, не борг фікстури (зафіксовано, не вигадуємо рішення мовчки).
    for (const [suffix, dueDays] of [['тиждень', 3], ['пізніше', 45]] as const) {
      const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${MT_PREFIX}${suffix}` })
      const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Р' })
      await api(request, csrf, 'post', `/courses/${course.id}/lessons`, { moduleId: mod.id, title: 'Урок', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] } })
      await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Візуальний тест' })
      await api(request, csrf, 'post', '/tasks', {
        subjectType: 'course', subjectId: course.id,
        audience: { rules: [{ type: 'user', ids: [emp!.id as string] }], match: 'any' },
        dueMode: 'relative', dueDays,
      })
    }
  })

  test.afterAll(async () => {
    await admin`delete from enrollments where subject_id in (select id from courses where title like ${`${MT_PREFIX}%`})`
    await admin`delete from assignments where subject_id in (select id from courses where title like ${`${MT_PREFIX}%`})`
    await admin`delete from courses where title like ${`${MT_PREFIX}%`}`
  })

  test('Learn home: /learn', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await loginViaUi(page, EMPLOYEE_PHONE)
    await page.goto('/learn')
    await stabilize(page)
    // «Аліно» в мокапі — ім'я в вітанні (приклад, не переноситься, docs/31 шапка); ЦЬОГО ТИЖНЯ/
    // ПІЗНІШЕ — тепер завжди є картка (фікстура вище); ПРОСТРОЧЕНО — не буває на вкладці «active»
    // ні за яких даних (див. коментар у beforeAll), тому в ignore, а не борг фікстури.
    await checkStructure(page, 'MyTasks', mockupTexts('MyTasks'), ['Аліно', 'ПРОСТРОЧЕНО'])
    await expect(page).toHaveScreenshot(`MyTasks-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: commonMask(page), animations: 'disabled' })
  })

  test('Profile: /learn/profile', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await loginViaUi(page, EMPLOYEE_PHONE)
    await page.goto('/learn/profile')
    await stabilize(page)
    await checkStructure(page, 'Profile', mockupTexts('Profile'))
    await expect(page).toHaveScreenshot(`Profile-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: [...commonMask(page), page.locator('.name'), page.locator('.sub')], animations: 'disabled' })
  })
})

// ---------------------------------------------------------------------------------------------
// Notice — мобильный, объявление с подписью на отдельной странице /learn/notices/:id
// ---------------------------------------------------------------------------------------------
test.describe('Notice', () => {
  const PREFIX = 'E2E-visual-notice '
  let noticeId = ''

  test.beforeAll(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'mobile') return
    await resetOtp()
    const { csrf } = await apiLogin(request, ADMIN_PHONE)
    // Заголовок дослівно з мокапа Notice.html — так структурна перевірка порівнює не «чи є
    // взагалі h1», а справжній текст мокапа (дані мокапів — приклади, docs/31 шапка, тому
    // збігу за змістом не буде на реальному оголошенні, і тут ми свідомо його підлаштовуємо)
    const n = await api<{ id: string }>(request, csrf, 'post', '/notices', {
      title: `${PREFIX}Нові правила видачі форми`,
      body: [{ id: 'b1', type: 'text', html: '<p>Текст оголошення для візуального тесту.</p>' }],
      kind: 'acknowledge',
      blockUntilAck: false,
      showMode: 'banner', // без модалки-гейта (вона зʼявляється для будь-якого showMode:'modal', не тільки при blockUntilAck) — знімаємо саме сторінку /learn/notices/:id, не оверлей
      publish: true,
    })
    noticeId = n.id
    const [emp] = await admin`select id from users where phone = ${EMPLOYEE_PHONE}`
    await api(request, csrf, 'post', '/tasks', { subjectType: 'notice', subjectId: n.id, audience: { rules: [{ type: 'user', ids: [emp!.id as string] }], match: 'any' }, dueMode: 'relative', dueDays: 7 })
  })

  test.afterAll(async () => {
    await admin`delete from assignments where subject_type = 'notice' and title like ${`${PREFIX}%`}`
    await admin`delete from notices where title like ${`${PREFIX}%`}`
  })

  test('Notice: /learn/notices/:id', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await loginViaUi(page, EMPLOYEE_PHONE)
    await page.goto(`/learn/notices/${noticeId}`)
    const heading = page.getByRole('heading', { level: 1, name: new RegExp(PREFIX) })
    await expect(heading).toBeVisible()
    await stabilize(page)
    await checkStructure(page, 'Notice', mockupTexts('Notice'))
    await expect(page).toHaveScreenshot(`Notice-${testInfo.project.name}.png`, { maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO, mask: [...commonMask(page), heading], animations: 'disabled' })
  })
})
