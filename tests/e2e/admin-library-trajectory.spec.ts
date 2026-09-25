import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * PR-26 пакета `docs/v2`: библиотека модулей на полотне траектории (`31-module-library.md` §5.4,
 * §5.5, критерий 2; условие выхода — узел показывает закреплённую версию, а не последнюю).
 *
 * Здесь — то, чего не видит integration-тест: узел-ссылка на полотне подписан «Бібліотека · v1»
 * и после выхода v2 остаётся на v1 с баннером «Доступна нова версія v2»; диалог обновления
 * показывает «з v1 до v2» и changelog, после «Оновити» узел — на v2; палитра «Бібліотека
 * модулів ▸» ставит модуль новым блоком, и полотно сохраняется.
 */

const PREFIX = 'E2E-LIB '
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

test.afterAll(async () => {
  const trajs = (await admin`select id from trajectories where title like ${`${PREFIX}%`}`).map(r => r.id as string)
  if (trajs.length) await admin`delete from trajectories where id in ${admin(trajs)}` // узлы уходят каскадом и отпускают версии
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

test('Бібліотека в траєкторії: вузол на закріпленій версії, «Оновити до останньої», палітра вставляє модуль', async ({ page, request }) => {
  test.slow()
  const stamp = Date.now()
  const title = `${PREFIX}Хімія ${stamp}`
  const { csrf } = await apiLogin(request, ADMIN_PHONE)
  const m = await api<{ id: string }>(request, csrf, 'post', '/library/modules', { title, contentKind: 'article', body: [{ id: 'b1', type: 'text', html: '<p>Розводимо 1:20</p>' }] })
  await api(request, csrf, 'post', `/library/modules/${m.id}/versions`, { changelog: 'Перша версія' })

  // Траєкторія Start → модуль бібліотеки (v1) → Finish; v2 виходить уже після вставки
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
  await page.goto(`/admin/trajectories/${t.id}`)
  const node = page.getByTestId('traj-node-library')
  await expect(node).toContainText('Бібліотека · v1')
  await node.click()
  const card = page.getByTestId('traj-library-card')
  await expect(card).toContainText('Це посилання на модуль бібліотеки')
  await expect(card).toContainText('Доступна нова версія v2')

  // Критерий 2: диалог — «з v1 до v2» и changelog пропущенной версии; после подтверждения узел на v2
  await page.getByTestId('traj-library-update').click()
  const dialog = page.getByTestId('library-update-dialog')
  await expect(dialog).toContainText('з v1 до v2')
  await expect(dialog).toContainText('Друга: нова концентрація')
  await page.getByTestId('library-update-confirm').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('traj-node-library')).toContainText('Бібліотека · v2')

  // Палитра §5.4: поиск по названию, выбор — новый блок-ссылка, полотно сохраняется
  await page.getByTestId('traj-library').click()
  const palette = page.getByTestId('library-palette')
  await palette.getByRole('searchbox').fill(`Хімія ${stamp}`)
  await palette.getByTestId(`library-pick-${m.id}`).click()
  await expect(page.getByTestId('traj-node-library')).toHaveCount(2)
  await page.getByRole('button', { name: /^Зберегти$/ }).click()
  await expect(page.locator('.note.teal', { hasText: 'Збережено' })).toBeVisible()
  const [row] = await admin`select count(*)::int as n from trajectory_nodes where trajectory_id = ${t.id} and library_version_id is not null`
  expect(row!.n).toBe(2)
})
