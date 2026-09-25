import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-34 пакета `docs/v2` (`38` §5.1, §13 к. 11): карточка человека, вкладка
 * «Активність» — карта года. День, в котором у человека есть события, закрашен своим уровнем,
 * подсказка называет число событий, по сетке ходят стрелками, на узком экране карта
 * прокручивается внутри своего блока, а журнал действий остался на той же вкладке.
 *
 * Сам расчёт дня по поясу человека (22:40 UTC у человека на UTC+4 → следующий день) и карта после
 * `activity.purge` проверены на сервисе — `tests/integration/v2-user-activity.spec.ts`: там можно
 * задать момент события. Здесь день кладётся в агрегат напрямую — экран рисует ровно его.
 */

const db = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
let personId = ''
let tenantId = ''
let day = ''
let nextWeek = ''

test.beforeAll(async () => {
  const [p] = await db`select id, tenant_id from users where phone = ${EMPLOYEE_PHONE}`
  personId = p!.id as string
  tenantId = p!.tenant_id as string
  // Месяц назад по Киеву (точка посевного сотрудника) — заведомо в прошлом и внутри окна карты;
  // день и тот же день недели следующей недели — в одном году (иначе стрелка ушла бы за сетку)
  const [d] = await db`
    with base as (select (now() at time zone 'Europe/Kyiv')::date - 30 as d)
    select (case when extract(year from d) = extract(year from d + 7) then d else d - 7 end)::text as day,
           (case when extract(year from d) = extract(year from d + 7) then d + 7 else d end)::text as next
    from base`
  day = d!.day as string
  nextWeek = d!.next as string
  await db`insert into user_activity_daily (tenant_id, user_id, local_date, events_count, kinds, level)
    values (${tenantId}, ${personId}, ${day}, 2, '{"lesson_completed": 1, "attempt_graded": 1}'::jsonb, 1)
    on conflict (tenant_id, user_id, local_date) do update set events_count = 2, kinds = excluded.kinds, level = 1`
})

test.afterAll(async () => {
  await db`delete from user_activity_daily where user_id = ${personId} and local_date = ${day}`
  await db.end()
})

test.beforeEach(resetOtp)

test('картка людини: день закрашений, підказка, стрілки, вузький екран і журнал дій (к. 11)', async ({ page }) => {
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto(`/admin/people/${personId}?tab=activity`)

  const map = page.locator('section.activity')
  await expect(map.getByRole('heading', { name: /Активність за/ })).toBeVisible()
  // День прошлого года (начало января) — переключить год селектором
  const year = Number(day.slice(0, 4))
  const select = map.locator('select')
  if (await select.count()) await select.selectOption(String(year))

  const cell = map.locator(`button.cell[data-date="${day}"]`)
  await expect(cell).toHaveClass(/\bl1\b/)
  await cell.focus()
  await expect(map.locator('.tip')).toContainText('2 події')

  // В сетку — один заход Tab, дальше стрелки: → — та же строка следующей недели
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-date'))).toBe(nextWeek)

  await expect(page.getByRole('heading', { name: 'Журнал дій' })).toBeVisible()

  // 320px: карта не расталкивает страницу — прокручивается внутри своего блока
  await page.setViewportSize({ width: 320, height: 720 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const box = await map.boundingBox()
  expect(box!.width).toBeLessThanOrEqual(320)
  const scrolls = await map.locator('.scroll').evaluate(el => el.scrollWidth > el.clientWidth)
  expect(scrolls).toBe(true)
})
