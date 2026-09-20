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
    // Назва — дослівно приклад з мокапа TaskCard.html (докладніше — коментар у Notice нижче)
    const course = await api<{ id: string }>(request, csrf, 'post', '/courses', { title: `${PREFIX}Тест «Касова дисципліна на ТТ»` })
    const mod = await api<{ id: string }>(request, csrf, 'post', `/courses/${course.id}/modules`, { title: 'Розділ' })
    await api(request, csrf, 'post', `/courses/${course.id}/lessons`, { moduleId: mod.id, title: 'Урок', resource: { body: [{ id: 'b', type: 'text', html: '<p>x</p>' }] } })
    await api(request, csrf, 'post', `/courses/${course.id}/publish`, { changelog: 'Перша публікація для візуального тесту' })
    const [emp] = await admin`select id from users where phone = ${EMPLOYEE_PHONE}`
    const created = await api<{ id: string }>(request, csrf, 'post', '/tasks', {
      subjectType: 'course',
      subjectId: course.id,
      audience: { rules: [{ type: 'user', ids: [emp!.id as string] }], match: 'any' },
      dueMode: 'relative',
      dueDays: 14,
    })
    assignmentId = created.id
  })

  test.afterAll(async () => {
    await admin`delete from enrollments where subject_id in (select id from courses where title like ${`${PREFIX}%`})`
    await admin`delete from assignments where subject_id in (select id from courses where title like ${`${PREFIX}%`})`
    await admin`delete from courses where title like ${`${PREFIX}%`}`
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
  test('Learn home: /learn', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'кабінет — тільки mobile')
    await loginViaUi(page, EMPLOYEE_PHONE)
    await page.goto('/learn')
    await stabilize(page)
    // «Аліно» в мокапі — ім'я в вітанні (приклад, не переноситься, docs/31 шапка); секційні
    // капс-заголовки ПРОСТРОЧЕНО/ЦЬОГО ТИЖНЯ/ПІЗНІШЕ показуються тільки коли в групі є картки —
    // однієї тестової фікстури мало, щоб заповнити всі три (docs/28 «visual-mockups»)
    await checkStructure(page, 'MyTasks', mockupTexts('MyTasks'), ['Аліно'])
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
