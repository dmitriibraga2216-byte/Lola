import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

const PREFIX = 'E2E-заняття '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)
test.afterAll(async () => {
  await admin`delete from meetups where title like ${PREFIX + '%'}`
  await admin.end()
})

test('10. Занятие создаётся, человек записывается, посещаемость отмечается по QR, отчёт сходится (docs/07 этап 9)', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const me = await api<{ user: { id: string } }>(request, csrf, 'get', '/auth/me')
  const inHour = new Date(Date.now() + 3_600_000).toISOString()
  const inThree = new Date(Date.now() + 3 * 3_600_000).toISOString()
  const m = await api<{ id: string }>(request, csrf, 'post', '/meetups', { title: `${PREFIX}Латте-арт`, startsAt: inHour, endsAt: inThree, trainerIds: [me.user.id], capacity: 5, attendanceMode: 'qr', enrollDeadlineHours: 0 })

  // Сотрудник записывается из карточки
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto(`/learn/meetups/${m.id}`)
  await page.getByTestId('mt-register').click()
  await expect(page.getByText('Ви записані')).toBeVisible()

  // Занятие «началось» (сдвигаем), тренер показывает QR — берём токен через API и отмечаемся кодом
  await admin`update meetups set starts_at = now() - interval '5 minutes' where id = ${m.id}`
  const qr = await api<{ token: string }>(request, csrf, 'get', `/meetups/${m.id}/qr`)
  await page.goto('/learn/meetups/checkin')
  await page.getByTestId('checkin-token').fill(qr.token)
  await page.getByTestId('checkin-send').click()
  await expect(page.getByText(/Присутність відмічено/)).toBeVisible()

  // Тренер видит отметку qr в списке участников; отчёт сходится
  const card = await api<{ participants: { status: string, checkInMethod: string }[] }>(request, csrf, 'get', `/meetups/${m.id}`)
  expect(card.participants).toHaveLength(1)
  expect(card.participants[0]).toMatchObject({ status: 'attended', checkInMethod: 'qr' })
  await admin`update meetups set status = 'finished', ends_at = now() - interval '2 hours' where id = ${m.id}`
  const rep = await api<{ meetups: { id: string, registered: number, attended: number }[] }>(request, csrf, 'get', '/reports/attendance')
  expect(rep.meetups.find(x => x.id === m.id)).toMatchObject({ registered: 1, attended: 1 })
})
