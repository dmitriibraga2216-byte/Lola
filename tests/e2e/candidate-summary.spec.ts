import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import postgres from 'postgres'

/**
 * Сценарий приёмки PR-29 (docs/v2/30-ai-interview.md §5.4, §13 к. 14; сквозная проверка 24 `docs/v2/42`
 * §5): кандидат открывает «Підсумок» по ссылке из письма **без входа** и с телефона — 320 px, ни одного
 * горизонтального скролла; внизу документа — строка «Документ сформовано автоматично…»; разделы,
 * выключенные рекрутером, не показываются; имя автора оценки (ПД третьего лица) не видно; отозванная
 * ссылка говорит об этом прямо.
 */

const MARK = 'E2E Підсумок'
const PHONE = '+380679966001'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })
const token = randomBytes(24).toString('base64url')
const revoked = randomBytes(24).toString('base64url')

test.afterAll(async () => {
  const people = await admin`select id from users where phone = ${PHONE}`
  for (const r of people) {
    await admin`delete from candidate_summaries where candidate_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from rate_limits where key like 'summary:view:%'`
  await admin.end()
})

test('к. 14: Підсумок за посиланням без входу — 320 px, рядок «Документ сформовано автоматично», без ПД третіх осіб', async ({ page }) => {
  const [tenant] = await admin`select id from tenants where slug = 'kappi'`
  const [person] = await admin`
    insert into users ${admin({ tenant_id: tenant!.id, kind: 'candidate', candidate_state: 'active', full_name: MARK, phone: PHONE, status: 'active', comm_language: 'uk', source: 'manual' })}
    returning id`
  const body = {
    candidate: { fullName: MARK, vacancyTitle: 'Бариста' },
    progress: { items: [{ title: 'Стандарти сервісу', kind: 'course', status: 'done', score: 92, finishedAt: null }] },
    scores: { items: [{ kind: 'recruiter', value: 71, authorName: 'Рекрутерка Прихована', at: new Date().toISOString(), aiStub: false }] },
    interview: null,
    strengthsRisks: { status: 'ready', strengths: ['Спокійно пояснює гостям правила закладу'], risks: [], caveat: 'Цей розділ сформувала програма. Це не висновок про людину і не підстава для рішення — рішення ухвалює людина.', aiStub: false },
    incomplete: { items: [] },
    passport: { generatedAt: new Date().toISOString(), model: null, promptVersion: null, humanChecked: true, aiStub: false },
    disclaimer: { text: 'Документ сформовано автоматично на основі відповідей кандидата.', humanChecked: true, humanCheckedText: 'Оцінки програми перевірено людиною: так.' },
  }
  const base = { tenant_id: tenant!.id, candidate_id: person!.id, completeness: 'full', body: admin.json(body), lang: 'uk', sent_at: new Date(), share_expires_at: new Date(Date.now() + 30 * 86_400_000), sent_channel: 'email' }
  await admin`insert into candidate_summaries ${admin({ ...base, version: 1, state: 'revoked', share_token: revoked, revoked_at: new Date(), revoke_reason: 'superseded', sections: admin.json(['candidate']) })}`
  await admin`insert into candidate_summaries ${admin({ ...base, version: 2, state: 'sent', share_token: token, sections: admin.json(['candidate', 'scores', 'strengths_risks']) })}`

  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`/summary/${token}`)
  await expect(page.getByRole('heading', { name: 'Підсумок кандидата' })).toBeVisible()
  await expect(page.getByText('Документ сформовано автоматично на основі відповідей кандидата. Оцінки програми перевірено людиною: так.')).toBeVisible()
  await expect(page.getByText('Спокійно пояснює гостям правила закладу')).toBeVisible()
  // Вимкнений рекрутером розділ «Пройдене і результати» не показується; ім'я автора оцінки — теж
  await expect(page.getByText('Стандарти сервісу')).toHaveCount(0)
  await expect(page.getByText('Рекрутерка Прихована')).toHaveCount(0)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  await page.goto(`/summary/${revoked}`)
  await expect(page.getByRole('alert')).toHaveText('Доступ до документа відкликано')
})
