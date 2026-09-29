import { devices, expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Замечания администратора с прода 27.09 (iPad Safari) — по сценарию на каждое:
 *  1. ресурс «Сторінка»: пустые блоки «Заголовок» не сохраняются, уровень — переключатель H2/H3;
 *  2. чек-лист: Enter в textarea даёт новый пункт, пустой чек-лист не ломает сохранение;
 *  3. «Дата народження» — день, месяц и год выбираются (три списка вместо input[type=date]);
 *  4. «Розміщення»: пустой справочник объясняется ссылкой, упавший — просьбой обновить;
 *  5. «База знань → Створити»: короткое название объясняется, а не глушит кнопку.
 * Эмуляция iPad (вьюпорт, touch, UA) без WebKit: движок — тот, что у проекта.
 */
const { defaultBrowserType: _engine, ...ipad } = devices['iPad Pro 11']
test.use(ipad)

const db = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
const stamp = Date.now()
const PREFIX = `E2E-2709 ${stamp}`
let tenantId = ''

test.beforeAll(async () => {
  tenantId = (await db`select id from tenants where slug = 'kappi'`)[0]!.id as string
})

test.afterAll(async () => {
  await db`delete from resources where title like ${`${PREFIX}%`}`
  await db`delete from knowledge_articles where title like ${`${PREFIX}%`}`
  await db`delete from users where last_name = ${`Датова${stamp}`}`
  await db`delete from cities where name = ${`${PREFIX} Київ`}`
  await db.end()
})

test.beforeEach(async ({ page }) => {
  await resetOtp()
  await loginViaUi(page, ADMIN_PHONE)
})

test('ресурс: пустые заголовки и пустой чек-лист не сохраняются, Enter в чек-листе — новый пункт', async ({ page }) => {
  await page.goto('/admin/resources/new')
  await page.getByRole('textbox', { name: 'Назва', exact: true }).fill(`${PREFIX} Сторінка`)
  const editor = page.locator('.editor')
  const add = (name: string) => editor.locator('.add button', { hasText: name }).click()

  // По умолчанию блоков нет
  await expect(editor.locator('[data-block-id]')).toHaveCount(0)

  // Новый заголовок сразу в фокусе; уровень — переключатель
  await add('Заголовок')
  await expect(page.getByPlaceholder('Текст заголовка').first()).toBeFocused()
  await page.keyboard.type('Видача замовлення')
  const levels = editor.getByRole('radiogroup', { name: 'Рівень заголовка' }).first()
  await levels.getByRole('radio', { name: 'H3' }).click()
  await expect(levels.getByRole('radio', { name: 'H3' })).toHaveAttribute('aria-checked', 'true')

  // Два пустых заголовка и пустой чек-лист — заготовки, в ресурс не идут
  await add('Заголовок')
  await add('Заголовок')
  await add('Чек-лист')
  await add('Чек-лист')
  const lists = editor.getByRole('textbox', { name: 'По пункту на рядок' })
  await lists.last().click()
  await page.keyboard.type('Каса')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Термінал')
  await expect(lists.last()).toHaveValue('Каса\nТермінал')
  await expect(editor.getByText('Пунктів: 2')).toBeVisible()

  const saved = page.waitForResponse(r => r.url().endsWith('/api/v1/resources') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Зберегти і вийти' }).click()
  expect((await saved).status()).toBe(200)
  await page.waitForURL(/\/admin\/resources$/)

  const [row] = await db`select body from resources where title = ${`${PREFIX} Сторінка`}`
  const body = row!.body as { type: string, level?: number, text?: string, items?: string[] }[]
  expect(body.map(b => b.type)).toEqual(['heading', 'checklist'])
  expect(body[0]).toMatchObject({ level: 3, text: 'Видача замовлення' })
  expect(body[1]!.items).toEqual(['Каса', 'Термінал'])
})

test('человек: дата рождения — день, месяц и год выбираются и сохраняются', async ({ page }) => {
  await db`insert into cities (tenant_id, name) values (${tenantId}, ${`${PREFIX} Київ`})`
  const [loc] = await db`select l.name, u.name as unit from locations l join org_units u on u.id = l.org_unit_id where l.tenant_id = ${tenantId} and l.is_active order by l.name limit 1`
  const [pos] = await db`select name from positions where tenant_id = ${tenantId} and is_active order by name limit 1`

  await page.goto('/admin/people/new')
  await page.getByRole('textbox', { name: 'Прізвище' }).fill(`Датова${stamp}`)
  await page.getByRole('textbox', { name: 'Імʼя' }).fill('Ірина')
  await page.getByRole('textbox', { name: 'Телефон' }).fill(`+38093${String(stamp).slice(-7)}`)

  const birth = page.getByRole('group', { name: 'Дата народження' })
  await birth.getByRole('combobox', { name: 'День' }).selectOption('17')
  await birth.getByRole('combobox', { name: 'Місяць' }).selectOption({ label: 'травень' })
  await birth.getByRole('combobox', { name: 'Рік' }).selectOption('1995')

  await page.getByRole('combobox', { name: 'Місто' }).selectOption({ label: `${PREFIX} Київ` })
  await page.getByRole('combobox', { name: 'Підрозділ' }).selectOption({ label: String(loc!.unit) })
  await page.getByRole('combobox', { name: 'Точка' }).selectOption({ label: String(loc!.name) })
  await page.getByRole('combobox', { name: 'Посада' }).selectOption({ label: String(pos!.name) })
  await page.getByRole('button', { name: 'Зберегти' }).click()
  await page.waitForURL(/\/admin\/people\/[0-9a-f-]{36}$/)

  const [u] = await db`select to_char(birth_date, 'YYYY-MM-DD') as d from users where last_name = ${`Датова${stamp}`}`
  expect(u!.d).toBe('1995-05-17')
})

test('человек: пустой справочник объясняет, где его заполнить; неудавшийся — просит обновить', async ({ page }) => {
  await page.route('**/api/v1/refs/cities', r => r.fulfill({ json: { data: [] } }))
  await page.route('**/api/v1/refs/positions', r => r.fulfill({ status: 500, json: {} }))
  await page.goto('/admin/people/new')

  const city = page.locator('[data-hint="empty"]').filter({ hasText: 'Довідник міст порожній' })
  await expect(city).toBeVisible()
  await expect(city.getByRole('link', { name: 'Відкрити довідники →' })).toHaveAttribute('href', '/admin/refs?kind=cities')
  await expect(page.locator('[data-hint="load_failed"]')).toHaveText('Не вдалося завантажити посади — оновіть сторінку.')
  // Остальные справочники загрузились — один упавший запрос не обнуляет все списки
  await expect(page.getByRole('combobox', { name: 'Точка' }).locator('option')).not.toHaveCount(1)

  await city.getByRole('link').click()
  await expect(page.getByRole('button', { name: 'Міста' })).toHaveClass(/on/)
})

test('база знаний: короткое название объясняется, нормальное — создаёт статью', async ({ page }) => {
  await page.goto('/admin/knowledge')
  const input = page.getByRole('textbox', { name: 'Назва нової статті' })
  const create = page.getByRole('button', { name: 'Створити' })
  await input.fill('Ри')
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByRole('alert')).toContainText('щонайменше 3 символи')
  await expect(input).toBeFocused()

  await input.fill(`${PREFIX} Стаття`)
  await create.click()
  await page.waitForURL(/\/admin\/knowledge\/[0-9a-f-]{36}$/)
})
