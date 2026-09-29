import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * «Індекс залученості» — `/admin/reports/rating` (docs/v2/38 §9 п. 5, §7.3; person-card-tails):
 * строка человека с основой, бонусами и «Разом», предупреждение «довідковий», выгрузка появляется
 * только после галки, 320px без горизонтальной прокрутки страницы. Выборка, область и ретро-расчёт —
 * `tests/integration/v2-person-rating-report.spec.ts`.
 */

const db = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
const stamp = Date.now()
const name = `Звіт індексу Е2Е ${stamp}`
let personId = ''

test.beforeAll(async () => {
  const tenantId = (await db`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [loc] = await db`select id from locations where tenant_id = ${tenantId} and name = 'Лазарева'`
  const [pos] = await db`select id from positions where tenant_id = ${tenantId} order by created_at limit 1`
  personId = (await db`insert into users (tenant_id, phone, full_name, status, rating_pct, rating_updated_at)
    values (${tenantId}, ${`+38098${String(stamp).slice(-7)}`}, ${name}, 'active', 97, now()) returning id`)[0]!.id as string
  await db`insert into user_placements (tenant_id, user_id, location_id, position_id, is_primary, started_at) values (${tenantId}, ${personId}, ${loc!.id}, ${pos!.id}, true, current_date - 30)`
  await db`insert into person_rating_snapshots (tenant_id, user_id, calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, breakdown, window_from, window_to, is_current)
    values (${tenantId}, ${personId}, current_date, 80, 2, 10, 5, 97, '{}'::jsonb, current_date - 364, current_date, true)`
})

test.afterAll(async () => {
  await db`delete from person_rating_snapshots where user_id = ${personId}`
  await db`delete from user_placements where user_id = ${personId}`
  await db`delete from users where id = ${personId}`
  await db.end()
})

test.beforeEach(resetOtp)

test('звіт: рядок людини, попередження, вивантаження лише після позначки; 320px', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/admin/reports/rating')
  await expect(page.getByRole('heading', { name: 'Індекс залученості' })).toBeVisible()
  await expect(page.getByText('Показник довідковий, не призначений для кадрових рішень.')).toBeVisible()
  const row = page.getByRole('row', { name: new RegExp(name) })
  await expect(row).toContainText('80')
  await expect(row).toContainText('97 %')

  const exportBox = page.getByTestId('rating-export')
  await expect(exportBox.getByRole('link', { name: 'Вивантажити xlsx' })).toHaveCount(0)
  await exportBox.getByRole('checkbox').check()
  await expect(exportBox.getByRole('link', { name: 'Вивантажити xlsx' })).toHaveAttribute('href', /confirm=1/)

  await page.setViewportSize({ width: 320, height: 720 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
