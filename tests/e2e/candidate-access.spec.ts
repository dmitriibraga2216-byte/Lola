import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, MENTOR_PHONE, api, apiLogin, loginViaUi, requestOtp, resetOtp } from './helpers'

/**
 * fix-candidate-access (docs/v2/28-recruiting-candidates.md §13 к. 7 и к. 10) — экраны.
 *
 * 1. Архивный кандидат вводит номер и код — остаётся на экране входа с текстом «Термін доступу
 *    завершився. Зверніться до рекрутера.»: отказ пришёл с сервера, текст — из словаря экрана.
 * 2. Наставник с назначенной проверкой открывает карточку кандидата: телефон и почта — «—», ни маски,
 *    ни её частей на странице; вкладки комментариев рекрутеров у него нет.
 *
 * Остальные пути входа (почта, выбор пространства, пароль, приглашение, Google, бот) и закрытие
 * действующих сессий — `tests/integration/v2-candidate-access.spec.ts`: там же, где решение.
 */

const ARCHIVED_PHONE = '+380679980001'
const CARD_PHONE = '+380679980002'
const CARD_EMAIL = 'e2e-fca-card@gmail.com'
const MARK = 'E2E FCA'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

async function kappiId(): Promise<string> {
  return (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
}

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const rows = await admin`select id from users where phone in (${ARCHIVED_PHONE}, ${CARD_PHONE})`
  for (const r of rows) {
    await admin`delete from review_queue_items where user_id = ${r.id}`
    await admin`delete from workshop_submissions where user_id = ${r.id}`
    await admin`delete from sessions where user_id = ${r.id}`
    await admin`delete from security_log where user_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from workshops where title like ${`${MARK}%`}`
  await admin`delete from otp_codes where phone in (${ARCHIVED_PHONE}, ${CARD_PHONE})`
  // Рекрутинг включался для карточки — соседние сценарии не должны видеть чужой раздел
  await admin`update tenants set candidates_enabled = false where slug = 'kappi'`
  await admin.end()
})

test('28 к. 7: архівний кандидат після коду бачить «Термін доступу завершився» і лишається на екрані входу', async ({ page }) => {
  await admin`insert into users ${admin({
    tenant_id: await kappiId(), kind: 'candidate', candidate_state: 'archived', full_name: `${MARK} Архівний`,
    phone: ARCHIVED_PHONE, status: 'active', comm_language: 'uk', source: 'manual',
  })}`

  const { devCode } = await requestOtp(page, ARCHIVED_PHONE)
  const verified = page.waitForResponse(r => r.url().includes('/auth/otp/verify'))
  await page.getByLabel('Введіть код').fill(devCode)
  expect((await verified).status()).toBe(403)

  await expect(page.getByRole('alert').filter({ hasText: 'Термін доступу' })).toHaveText('Термін доступу завершився. Зверніться до рекрутера.')
  await expect(page).toHaveURL(/\/login/)
})

test('28 к. 10: наставник відкриває картку кандидата — телефон і пошта «—», маски немає', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  // Без прапора тенанта ручки воронки відповідають 403 `candidates.disabled` (docs/v2/28, 03.guards)
  await api(request, csrf, 'patch', '/settings/recruiting', { enabled: true })

  const tenantId = await kappiId()
  const [mentor] = await admin`select id from users where tenant_id = ${tenantId} and phone = ${MENTOR_PHONE}`
  const [candidate] = await admin`insert into users ${admin({
    tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', full_name: `${MARK} Кандидат`,
    phone: CARD_PHONE, email: CARD_EMAIL, status: 'invited', comm_language: 'uk', source: 'manual',
  })} returning id`
  // Призначена перевірка: робота кандидата в черзі, взята наставником (§2, docs/v2/44 В-2)
  const [workshop] = await admin`
    insert into workshops (tenant_id, title, description, criteria, status)
    values (${tenantId}, ${`${MARK} тестове завдання`}, '{}'::jsonb, '[]'::jsonb, 'published') returning id`
  const [sub] = await admin`
    insert into workshop_submissions (tenant_id, workshop_id, user_id, criteria_snapshot, status, submitted_at)
    values (${tenantId}, ${workshop!.id}, ${candidate!.id}, '[]'::jsonb, 'in_review', now()) returning id`
  await admin`
    insert into review_queue_items (tenant_id, task_type, source_id, user_id, subject_kind, status, claimed_by, claimed_at)
    values (${tenantId}, 'workshop', ${sub!.id}, ${candidate!.id}, 'candidate', 'in_review', ${mentor!.id}, now())`

  await loginViaUi(page, MENTOR_PHONE)
  const card = page.waitForResponse(r => r.url().includes(`/api/v1/candidates/${candidate!.id}`) && r.request().method() === 'GET')
  await page.goto(`/admin/candidates/${candidate!.id}`)
  const body = await (await card).json() as { data: { phone: string | null, email: string | null } }
  // Відповідь API: поля є, але порожні — не маска
  expect(body.data.phone).toBeNull()
  expect(body.data.email).toBeNull()

  await expect(page.getByRole('heading', { name: `${MARK} Кандидат` })).toBeVisible()
  const overview = page.locator('section.card-grid')
  await expect(overview.locator('dt', { hasText: 'Телефон' }).locator('xpath=following-sibling::dd[1]')).toHaveText('—')
  await expect(overview.locator('dt', { hasText: 'Пошта' }).locator('xpath=following-sibling::dd[1]')).toHaveText('—')
  await expect(overview).not.toContainText('+380')
  await expect(overview).not.toContainText('**')
  await expect(overview).not.toContainText('gmail.com')
  await expect(page.getByRole('tab', { name: 'Коментарі' })).toHaveCount(0)
})
