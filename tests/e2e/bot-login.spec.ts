import { createHash, randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'

/**
 * Кнопка «Пройти» из бота (docs/23 §6 п. 7) — в браузере. Токен кнопки бот выпускает при отправке
 * сообщения (`issueLoginToken`); здесь строка токена кладётся в базу так же — хеш и срок 10 минут.
 *
 * 1. Действующая кнопка — вход без кода, сразу на страницу из ссылки.
 * 2. Та же кнопка ещё раз, в браузере без сессии, — экран входа с текстом «Посилання застаріло…».
 *
 * Все причины отказа, свойства токена, частотное ограничение и `/menu` —
 * `tests/integration/bot-login.spec.ts`.
 */

const MARK = 'E2E BotLogin'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.afterAll(async () => {
  const rows = await admin`select id from users where full_name = ${MARK}`
  for (const r of rows) {
    await admin`delete from sessions where user_id = ${r.id}`
    await admin`delete from security_log where user_id = ${r.id}`
    await admin`delete from telegram_tokens where user_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from rate_limits where key like 'tg:go:%'`
  await admin.end()
})

test('23 §6 п. 7: кнопка бота входит без кода; повторно — «Посилання застаріло», без входа', async ({ page }) => {
  const tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [person] = await admin`insert into users ${admin({
    tenant_id: tenantId, kind: 'employee', full_name: MARK, status: 'active',
    telegram_chat_id: 9_400_000_000 + Math.floor(Math.random() * 99_999_999),
  })} returning id`
  const token = randomBytes(24).toString('base64url')
  await admin`insert into telegram_tokens (tenant_id, user_id, kind, token_hash, expires_at)
    values (${tenantId}, ${person!.id}, 'login', ${createHash('sha256').update(token).digest('hex')}, now() + interval '10 minutes')`
  const button = `/tg/go?t=${token}&to=${encodeURIComponent('/learn')}`

  await page.goto(button)
  await expect(page).toHaveURL(/\/learn/)
  expect((await page.context().cookies()).some(c => c.name === 'lola_sid')).toBe(true)
  expect((await admin`select count(*)::int as c from sessions where user_id = ${person!.id}`)[0]!.c).toBe(1)

  await page.context().clearCookies()
  await page.goto(button)
  await expect(page).toHaveURL(/\/login\?error=tg_link_expired/)
  await expect(page.getByRole('alert').filter({ hasText: 'Посилання застаріло' }))
    .toHaveText('Посилання застаріло. Попросіть у бота нове — надішліть йому /menu — або увійдіть тут')
})
