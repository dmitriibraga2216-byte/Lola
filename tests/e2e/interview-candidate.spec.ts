import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { loginViaUi, resetOtp } from './helpers'

/**
 * Экраны кандидата ИИ-собеседования на телефоне (docs/v2/30 §5.1–§5.2, §6.3, §7.4, §7.5; сквозная
 * проверка 24 `docs/v2/42` §5): экран согласия, отказ с выбором альтернативы и само собеседование
 * текстом — на 320 px без горизонтального скролла, кнопки нажимаются с клавиатуры.
 *
 * Данные готовятся SQL-ом: тест собеседования с одним вопросом, опубликованный сценарий, назначение
 * на двух кандидатов. Оценка ИИ здесь не проверяется (воркер выключен) — только экраны.
 */

const MARK = 'E2E Співбесіда'
const PHONES = ['+380679977001', '+380679977002']
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
let quizId: string
let recruitingWas = false

const noOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeEach(resetOtp)

test.beforeAll(async () => {
  const [tenant] = await admin`select id, candidates_enabled from tenants where slug = 'kappi'`
  const tenantId = tenant!.id as string
  recruitingWas = tenant!.candidates_enabled as boolean
  await admin`update tenants set candidates_enabled = true where id = ${tenantId}`
  await admin`insert into tenant_limits (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`
  await admin`update tenant_limits set ai_status = 'active', ai_interview_ops = null where tenant_id = ${tenantId}`
  const [owner] = await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`
  const ids: string[] = []
  for (const [i, phone] of PHONES.entries()) {
    const [u] = await admin`insert into users ${admin({
      tenant_id: tenantId, kind: 'candidate', candidate_state: 'active', full_name: `${MARK} ${i + 1}`, phone, status: 'active',
      comm_language: 'uk', source: 'manual', recruiter_id: owner!.id, consent_given_at: new Date(),
      consent_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10),
      access_until: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    })} returning id`
    ids.push(u!.id as string)
  }
  const [bank] = await admin`insert into question_banks (tenant_id, name) values (${tenantId}, ${`${MARK} банк`}) returning id`
  const [quiz] = await admin`insert into quizzes (tenant_id, title, kind, status, selection_mode, question_count)
    values (${tenantId}, ${`${MARK} тест`}, 'interview', 'published', 'fixed', 1) returning id`
  quizId = quiz!.id as string
  const [q] = await admin`insert into questions (tenant_id, bank_id, kind, stem, answer, points)
    values (${tenantId}, ${bank!.id}, 'free', ${admin.json([{ type: 'text', html: '<p>Розкажіть про свій досвід роботи з гостями</p>' }])}, ${admin.json({ criteria: ['досвід'] })}, 2)
    returning id`
  await admin`insert into quiz_questions (tenant_id, quiz_id, question_id, sort) values (${tenantId}, ${quizId}, ${q!.id}, 1)`
  const [sc] = await admin`insert into interview_scenarios ${admin({
    tenant_id: tenantId, quiz_id: quizId, name: `${MARK} сценарій`, interviewer_name: 'Лола',
    intro_text: 'Вітаю! Мене звати Лола. Я поставлю одне запитання про ваш досвід.', outro_text: 'Дякуємо! Відповіді надіслано рекрутеру.',
    alternative_path: 'human_interview', status: 'published', created_by: owner!.id,
  })} returning id`
  await admin`insert into interview_criteria (tenant_id, scenario_id, code, name_uk, description)
    values (${tenantId}, ${sc!.id}, 'service', 'Сервіс', 'Спокійно пояснює гостю ситуацію та пропонує рішення')`
  await admin`insert into assignments (tenant_id, title, subject_type, subject_id, audience, status, is_mandatory, params, created_by)
    values (${tenantId}, ${`${MARK} призначення`}, 'test', ${quizId}, ${admin.json({ rules: [{ type: 'user', ids }], match: 'any' })}, 'active', false, ${admin.json({ attemptsAllowed: 2 })}, ${owner!.id})`
})

test.afterAll(async () => {
  const people = await admin`select id from users where phone in ${admin(PHONES)}`
  const ids = people.map(p => p.id as string)
  if (ids.length) {
    await admin`delete from notifications where user_id in ${admin(ids)}`
    await admin`delete from usage_events where ref_id in (select id from interview_sessions where candidate_id in ${admin(ids)})`
    await admin`delete from interview_sessions where candidate_id in ${admin(ids)}`
    await admin`delete from interview_consents where user_id in ${admin(ids)}`
    await admin`delete from candidate_status_history where candidate_id in ${admin(ids)}`
    await admin`delete from review_queue_items where user_id in ${admin(ids)}`
    await admin`delete from attempt_answers where attempt_id in (select id from attempts where user_id in ${admin(ids)})`
    await admin`delete from attempt_results where attempt_id in (select id from attempts where user_id in ${admin(ids)})`
    await admin`delete from attempts where user_id in ${admin(ids)}`
    await admin`delete from ai_calls where subject_user_id in ${admin(ids)}`
    await admin`delete from sessions where user_id in ${admin(ids)}`
    await admin`delete from security_log where user_id in ${admin(ids)}`
    await admin`delete from audit_log where entity_id in ${admin(ids)} or actor_id in ${admin(ids)}`
    await admin`delete from task_access_log where user_id in ${admin(ids)}`
    await admin`delete from user_activity_events where user_id in ${admin(ids)}`
  }
  if (quizId) {
    await admin`delete from assignments where subject_id = ${quizId}`
    await admin`delete from interview_scenarios where quiz_id = ${quizId}`
    await admin`delete from quiz_questions where quiz_id = ${quizId}`
    await admin`delete from quizzes where id = ${quizId}`
  }
  await admin`delete from questions where bank_id in (select id from question_banks where name = ${`${MARK} банк`})`
  await admin`delete from question_banks where name = ${`${MARK} банк`}`
  if (ids.length) await admin`delete from users where id in ${admin(ids)}`
  await admin`update tenants set candidates_enabled = ${recruitingWas} where slug = 'kappi'`
  await admin.end()
})

test('згода → відмова з вибором альтернативи — 320 px, клавіатура', async ({ page }) => {
  await loginViaUi(page, PHONES[0]!)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`/interview/${quizId}`)
  await expect(page.getByRole('button', { name: 'Погоджуюсь і починаю' })).toBeVisible()
  await expect(page.getByText('Інтерв’юер: Лола')).toBeVisible()
  await noOverflow(page)

  const full = page.getByRole('button', { name: 'Повний текст згоди' })
  await full.focus()
  await page.keyboard.press('Enter')
  // Кнопка міняє підпис: розгорнутий текст згоди ховається нею ж
  await expect(page.getByRole('button', { name: 'Сховати повний текст' })).toHaveAttribute('aria-expanded', 'true')
  await noOverflow(page)

  await page.getByRole('button', { name: 'Не погоджуюсь' }).click()
  await expect(page.getByText('Ви не погодились на електронну співбесіду. Це нормально і не впливає на ваші шанси.')).toBeVisible()
  await noOverflow(page)
  await page.getByRole('button', { name: 'Надіслати' }).click()
  await expect(page.getByText('Дякуємо, рекрутер отримав ваш вибір')).toBeVisible()
  await noOverflow(page)
})

test('згода → співбесіда текстом → завершено — 320 px', async ({ page }) => {
  await loginViaUi(page, PHONES[1]!)
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`/interview/${quizId}`)
  await page.getByRole('button', { name: 'Погоджуюсь і починаю' }).click()
  await expect(page.getByText('Перевірка мікрофона')).toBeVisible()
  await noOverflow(page)

  await page.getByRole('button', { name: 'Відповідати текстом' }).click()
  await expect(page).toHaveURL(/\/interview\/session\//)
  await expect(page.getByText('Питання 1 з 1')).toBeVisible()
  await expect(page.getByText('Розкажіть про свій досвід роботи з гостями')).toBeVisible()
  await noOverflow(page)

  await page.getByLabel('Ваша відповідь').fill('Два роки працювала баристою: зустрічала гостей, спокійно пояснювала затримки і пропонувала рішення.')
  await page.getByRole('button', { name: 'Далі' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Далі' })).toHaveCount(0)
  await noOverflow(page)
})
