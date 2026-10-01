import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, MENTOR_PHONE, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * «Мої перевірки» — экран единой очереди проверки (docs/v2/37 §5.1, §5.2; review-time-tails).
 *
 * Наставник видит работу своего подопечного по траектории: в строке — «Відхилення» (факт втрое
 * больше плана), в карточке — строка времени и плашка «Ви навчали цю людину за цим треком» с
 * «Передати іншому», которая открывает форму делегирования с причиной «Конфлікт інтересів».
 * Выгрузки §9.1 у наставника нет (`report.export`), у администратора — файл той же очереди.
 */

const TITLE = 'E2E-rq Робота підопічного'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

let trajectoryId: string

test.beforeAll(async () => {
  await cleanup()
  const [emp] = await admin`select id, tenant_id from users where phone = ${EMPLOYEE_PHONE}`
  const [mentor] = await admin`select id from users where phone = ${MENTOR_PHONE}`
  const tenantId = emp!.tenant_id as string
  const [place] = await admin`select location_id from user_placements where user_id = ${emp!.id} and is_primary and ended_at is null`
  const [course] = await admin`select id from courses where tenant_id = ${tenantId} and published_version_id is not null order by created_at limit 1`
  // Работа в общем пуле точки: норма 10 хв, факт 25 + 5 хв — «Повільніше за план», ×3. Сдана
  // «давно», чтобы стоять первой в очереди, а срок — от сейчас, чтобы строка не была просрочена
  await admin`
    insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind, task_title, track_id, location_id,
      submitted_at, status, sla_hours, sla_due_at, estimated_seconds, content_seconds, attempt_seconds)
    values (${tenantId}, 'offline_confirm', gen_random_uuid(), ${emp!.id}, 'employee', ${TITLE}, ${course!.id}, ${place!.location_id},
      now() - interval '30 days', 'waiting', 48, now() + interval '48 hours', 600, 1500, 300)`
  // Наставник подопечного по траектории с этим курсом узлом (`37` §7.9)
  const [t] = await admin`insert into trajectories (tenant_id, title, status) values (${tenantId}, 'E2E-rq траєкторія', 'published') returning id`
  trajectoryId = t!.id as string
  await admin`insert into trajectory_nodes (tenant_id, trajectory_id, kind, content_type, content_id) values (${tenantId}, ${trajectoryId}, 'task', 'course', ${course!.id})`
  await admin`insert into trajectory_enrollments (tenant_id, trajectory_id, user_id, status, mentor_id) values (${tenantId}, ${trajectoryId}, ${emp!.id}, 'in_progress', ${mentor!.id})`
})

async function cleanup() {
  await admin`delete from review_queue_items where task_title = ${TITLE}`
  await admin`delete from trajectories where title = 'E2E-rq траєкторія'`
}

test.afterAll(async () => {
  await cleanup()
  await admin.end()
})

test.beforeEach(resetOtp)

test('«Мої перевірки»: «Відхилення», строка времени и «Ви навчали цю людину» с передачей', async ({ page }) => {
  await loginViaUi(page, MENTOR_PHONE)
  await page.goto('/admin/review-queue')
  await expect(page.getByRole('tab', { name: /Мої/ })).toHaveAttribute('aria-selected', 'true')

  const row = page.locator('tbody tr', { hasText: TITLE })
  await expect(row).toBeVisible()
  await expect(row.getByText('×3 · Повільніше за план')).toBeVisible()
  // Выгрузка §9.1 — только с `report.export`; у наставника его нет
  await expect(page.getByRole('link', { name: 'Вивантажити в Excel' })).toHaveCount(0)

  await row.getByRole('button', { name: 'Відкрити' }).click()
  const card = page.getByRole('dialog', { name: TITLE })
  await expect(card).toBeVisible()
  await expect(card.getByText('Розрахунковий час 10 хв · Контент 25 хв · Випробування 5 хв')).toBeVisible()
  await expect(card.getByText(/Ви навчали цю людину за цим треком/)).toBeVisible()

  await card.getByRole('button', { name: 'Передати іншому' }).click()
  const form = page.getByRole('dialog', { name: 'Делегування перевірки' })
  await expect(form).toBeVisible()
  await expect(form.getByLabel('Причина')).toHaveValue('conflict_of_interest')
})

test('выгрузка «Черга перевірки» (§9.1) администратору — файлом той же очереди', async ({ request }) => {
  await apiLogin(request, ADMIN_PHONE)
  const res = await request.get('/api/v1/review/queue?tab=mine&taskType=offline_confirm&format=csv')
  expect(res.status(), await res.text()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/csv')
  const body = await res.text()
  expect(body.split('\n')[0]).toContain('full_name;subject_kind;location;track;task_type;task_title;attempts;estimated_min')
  expect(body).toContain(TITLE)
})
