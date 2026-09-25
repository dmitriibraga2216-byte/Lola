import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-35 пакета `docs/v2` (`38` §5.1–§5.3, §13 к. 1–2; `33` §5.3; П-16.2, П-16.3):
 *  - список людей: колонка «%» показывает 130 % как есть, заголовок объясняет, почему больше 100;
 *  - экран «Звідки взявся відсоток»: четыре слагаемых с числами формулы и «Разом»;
 *  - карточка одной страницей: шапка с этапом → «Активність за {рік}» → «Призначені треки» →
 *    личные данные → «Нотатки» → «Документи» → «Відсутності».
 * Сам расчёт (формула, окно, `rating.recalc`, запрет индекса как единственного условия
 * архивирования) проверен на сервисе — `tests/integration/v2-person-rating.spec.ts`. Здесь снимок
 * кладётся в БД напрямую — экран рисует ровно его.
 */

const db = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
const stamp = Date.now()
const name = `Індекс Е2Е ${stamp}`
const topName = `Сто тридцять Е2Е ${stamp}`
let tenantId = ''
let personId = ''
let topId = ''

test.beforeAll(async () => {
  tenantId = (await db`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [loc] = await db`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  const [pos] = await db`select id from positions where tenant_id = ${tenantId} order by created_at limit 1`
  const [u] = await db`insert into users (tenant_id, phone, full_name, status, rating_pct, rating_updated_at)
    values (${tenantId}, ${`+38096${String(stamp).slice(-7)}`}, ${name}, 'active', 92, now()) returning id`
  personId = u!.id as string
  // Критерий 2: 100 % основы и максимальные бонусы — 130 в колонке «%»
  const [top] = await db`insert into users (tenant_id, phone, full_name, status, rating_pct, rating_updated_at)
    values (${tenantId}, ${`+38097${String(stamp).slice(-7)}`}, ${topName}, 'active', 130, now()) returning id`
  topId = top!.id as string
  await db`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${personId}, ${loc!.id}, ${pos!.id}, true, current_date - 30)`
  // Снимок с числами критерия 1: 8 из 10 обязательных, на 20 % раньше, серия 15, 10 действий
  const breakdown = {
    formula_version: 1,
    base: { weighted_done: 16, weighted_total: 20, items: [{ enrollmentId: 'e1', subjectId: 'c1', title: 'Онбординг кухаря', mandatory: true, weight: 2, status: 'done', credit: 1, contribution: 2 }] },
    early: { avg_share: 0.2, counted: 8, items: [] },
    streak: { longest: 15, target: 30 },
    help: { actions: 10, credited: 10, reviews: 6, issues: 4, target: 20 },
  }
  await db`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
    values (${tenantId}, ${personId}, current_date, 80, 2, 5, 5, 92, ${db.json(breakdown)}, current_date - 364, current_date, true)`
  const [stage] = await db`select id from lifecycle_stages where tenant_id = ${tenantId} and code = 'onboarding'`
  await db`insert into employee_lifecycle_state (tenant_id, user_id, stage_id, entered_at, reason_code, is_current) values (${tenantId}, ${personId}, ${stage!.id}, now() - interval '3 days', 'manual', true)`
})

test.afterAll(async () => {
  await db`delete from users where id in ${db([personId, topId])}` // снимки, размещение и этап уходят каскадом
  await db.end()
})

test.beforeEach(resetOtp)

test('список: «130 %» не обрізано, заголовок «%» пояснює індекс (к. 2)', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/people')
  await page.getByRole('searchbox').fill(topName)
  const row = page.locator('tr.row', { hasText: topName })
  await expect(row.locator('.rating')).toHaveText('130 %')
  await page.getByRole('button', { name: '%', exact: true }).click()
  await expect(page.locator('#rating-help')).toContainText('не відсоток проходження')
  await expect(page.locator('#rating-help')).toContainText('Може перевищувати 100 %')
})

test('розшифровка: чотири доданки з числами формули і «Разом» (к. 1)', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/people/${personId}/rating`)
  await expect(page.getByTestId('engagement-total')).toHaveText('92 %')
  await expect(page.getByRole('heading', { name: 'Основа: 80 зі 100' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Достроковість: +2 з 10' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Регулярність: +5 з 10' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Внесок у колег: +5 з 10' })).toBeVisible()
  await expect(page.getByText('Виконано 16 із 20 призначених модулів')).toBeVisible()
  await expect(page.getByText('Разом: 92 % (максимум 130 %)')).toBeVisible()
  await expect(page.getByText('Показник довідковий. Він не є підставою для кадрових рішень')).toBeVisible()

  await page.setViewportSize({ width: 320, height: 720 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('картка одною сторінкою: етап у шапці, блоки в порядку еталона (П-16.2)', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/people/${personId}`)
  await expect(page.getByTestId('person-stage')).toContainText('Онбординг, з')
  const tops = async (locators: ReturnType<typeof page.locator>[]) => Promise.all(locators.map(async l => (await l.boundingBox())!.y))
  const blocks = [
    page.getByRole('heading', { name: /Активність за/ }),
    page.getByRole('heading', { name: 'Призначені треки' }),
    page.getByRole('heading', { name: 'Профіль', exact: true }),
    page.locator('#person-section-notes'),
    page.locator('#person-section-documents'),
    page.locator('#person-section-absences'),
  ]
  for (const b of blocks) await expect(b).toBeVisible()
  const ys = await tops(blocks)
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  // Два різні числа підписані по-різному: бали рейтингу й індекс залученості
  await expect(page.getByText('Бали рейтингу')).toBeVisible()
  await expect(page.locator('a.index-chip')).toContainText('92 %')
})
