import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Экраны библиотеки модулей (`docs/v2/31` §5.1–§5.3, §5.5; ветка `library-tails`, часть 2):
 * список с колонкой «Використання», карточка с вкладками «Вміст» / «Версії» / «Де
 * використовується», «Порівняти з v1», диалог удаления используемого модуля с предложением
 * заархивировать и архивирование с причиной. Плюс раскладка на 320 px без горизонтальной прокрутки.
 */

const PREFIX = 'E2E-LIBSCR '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const trajs = (await admin`select id from trajectories where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (trajs.length) await admin`delete from trajectories where id in ${admin(trajs)}`
  const mods = (await admin`select id from library_modules where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (mods.length) {
    await admin`delete from library_module_usages where library_module_id in ${admin(mods)}`
    await admin`update library_modules set current_version_id = null, draft_lesson_id = null where id in ${admin(mods)}`
    await admin`delete from library_module_versions where library_module_id in ${admin(mods)}`
    const bodies = (await admin`select item_id from lessons where library_module_id in ${admin(mods)}`).map(r => r.item_id as string)
    await admin`delete from lessons where library_module_id in ${admin(mods)}`
    await admin`delete from library_modules where id in ${admin(mods)}`
    if (bodies.length) await admin`delete from resources where id in ${admin(bodies)}`
  }
  await admin.end()
})

test('Бібліотека модулів: список, картка з версіями і місцями, видалення використовуваного → архів', async ({ page, request }) => {
  test.slow()
  const stamp = Date.now()
  const title = `${PREFIX}Хімія ${stamp}`
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const m = await api<{ id: string }>(request, csrf, 'post', '/library/modules', { title, contentKind: 'article', body: [{ id: 'b1', type: 'text', html: '<p>Розводимо 1:20</p>' }] })
  await api(request, csrf, 'post', `/library/modules/${m.id}/versions`, { changelog: 'Перша версія' })

  const t = await api<{ id: string }>(request, csrf, 'post', '/trajectories', { title: `${PREFIX}Траєкторія ${stamp}` })
  const g = await api<{ nodes: { id: string, kind: string }[] }>(request, csrf, 'get', `/trajectories/${t.id}/graph`)
  const start = g.nodes.find(n => n.kind === 'start')!
  const finish = g.nodes.find(n => n.kind === 'finish')!
  await api(request, csrf, 'put', `/trajectories/${t.id}/graph`, {
    nodes: [
      { id: start.id, kind: 'start', x: 16, y: 40 },
      { id: finish.id, kind: 'finish', x: 440, y: 40 },
      { tmpId: 'tmp:lib', kind: 'task', libraryModuleId: m.id, params: {}, x: 220, y: 40 },
    ],
    edges: [{ fromNodeId: start.id, toNodeId: 'tmp:lib' }, { fromNodeId: 'tmp:lib', toNodeId: finish.id }],
  })
  await api(request, csrf, 'patch', `/library/modules/${m.id}`, { body: [{ id: 'b1', type: 'text', html: '<p>Розводимо 1:10</p>' }] })
  await api(request, csrf, 'post', `/library/modules/${m.id}/versions`, { changelog: 'Друга: нова концентрація' })

  await loginViaUi(page, ADMIN_PHONE)
  // §5.1: поиск и колонка «Використання»
  await page.goto('/admin/library')
  await page.getByPlaceholder('Пошук за назвою або вмістом').fill(title)
  const row = page.getByRole('row', { name: new RegExp(title) })
  await expect(row).toContainText('у 1 місцях')
  await expect(row).toContainText('застарілих: 1')
  await row.getByRole('link', { name: title }).click()

  // §5.2: плашка использования, вкладка «Версії» и «Порівняти з v1»
  await expect(page.getByText('Цей модуль використовується у 1 місцях')).toBeVisible()
  await page.getByRole('tab', { name: /Версії/ }).click()
  await expect(page.getByRole('cell', { name: 'Друга: нова концентрація' })).toBeVisible()
  await page.getByRole('button', { name: 'Порівняти з v1' }).click()
  await expect(page.getByRole('dialog')).toContainText('Зміни з v1 до v2')
  await page.getByRole('button', { name: 'Закрити' }).click()

  // §5.3: место на v1 — «застаріло»
  await page.getByRole('tab', { name: /Де використовується/ }).click()
  await expect(page.getByRole('cell', { name: 'v1 · застаріло' })).toBeVisible()

  // §5.5: удалить используемый нельзя — предложено «Заархівувати» с причиной
  await page.getByRole('button', { name: 'Інші дії' }).click()
  await page.getByRole('menuitem', { name: 'Видалити' }).click()
  await expect(page.getByRole('dialog')).toContainText('Модуль використовується')
  await page.getByRole('dialog').getByRole('button', { name: 'Заархівувати' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Заархівувати' }).click()
  await expect(page.getByRole('dialog')).toContainText('Вкажіть причину')
  await page.getByRole('dialog').locator('textarea').fill('Замінено новим стандартом')
  await page.getByRole('dialog').getByRole('button', { name: 'Заархівувати' }).click()
  await expect(page.getByText('Модуль заархівовано')).toBeVisible()
})

test('Бібліотека модулів на 320 px: без горизонтальної прокрутки сторінки', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await loginViaUi(page, ADMIN_PHONE)
  for (const path of ['/admin/library', '/admin/library/reports']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, path).toBeLessThanOrEqual(0)
  }
})
