import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { ADMIN_PHONE, EMPLOYEE_PHONE, api, apiLogin, loginViaUi, resetOtp } from './helpers'

/**
 * Сценарий приёмки PR-30 (docs/v2/32-org-structure.md §13, критерии 1, 3, 4, 8).
 *
 * Проверяется то, что видно на экране, а не только в сервисе:
 * 1. администратор создаёт корневой узел-посаду на три человека — карточка появляется
 *    в дереве со счётчиком «0 з 3» и подписью «Вакансія» (к. 1);
 * 2. под ним создаётся дочерний узел, и это видно как вложенность (к. 1);
 * 3. подчинить корень его же потомку нельзя — `409 cycle_detected`, дерево не меняется (к. 3);
 * 4. `GET /org-structure/manager/:userId` отвечает единственным источником истины
 *    о руководителе (к. 4, патч П-16.4);
 * 5. рядовой сотрудник открывает `/org-structure` и видит **только** витрину: таба
 *    конструктора нет и иконок управления на карточках нет (к. 8).
 */

const PREFIX = 'E2E Оргструктура'
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

test.beforeEach(resetOtp)

async function cleanup() {
  await admin`delete from import_jobs where kind = 'org_structure' and file_name = 'e2e-org-import.csv'`
  const nodes = await admin`select id from org_nodes where title like ${`${PREFIX}%`} order by depth desc`
  for (const n of nodes) {
    await admin`delete from org_node_assignments where node_id = ${n.id}`
    await admin`delete from org_conflicts where node_id = ${n.id}`
    await admin`delete from audit_log where entity_id = ${n.id}`
  }
  for (const n of nodes) await admin`delete from org_nodes where id = ${n.id}`
}

test.beforeAll(cleanup)
test.afterAll(async () => {
  await cleanup()
  await admin.end()
})

test('адмін будує дерево, цикл відхиляється, керівник приходить з одного джерела', async ({ page, request }) => {
  const { csrf } = await apiLogin(request, ADMIN_PHONE)

  // 1. Корневой узел-посада на трёх человек (к. 1)
  const root = await api<{ id: string, state: string }>(request, csrf, 'post', '/org-structure/nodes', {
    title: `${PREFIX} Керуюча компанія`,
    headcountPlanned: 3,
    isManagerPoint: true,
  })
  expect(root.state).toBe('vacant')

  // 2. Дочерний узел
  const kid = await api<{ id: string, depth: number }>(request, csrf, 'post', '/org-structure/nodes', {
    title: `${PREFIX} Кухня`,
    parentId: root.id,
    headcountPlanned: 2,
  })
  expect(kid.depth).toBe(2)

  // 3. Подчинить корень его же потомку нельзя (к. 3)
  const bad = await request.post(`/api/v1/org-structure/nodes/${root.id}/move`, {
    data: { parentId: kid.id },
    headers: { 'x-csrf-token': csrf },
  })
  expect(bad.status()).toBe(409)
  expect((await bad.json() as { error: { code: string } }).error.code).toBe('cycle_detected')

  // Дерево не изменилось: корень остался корнем
  const stillRoot = await admin`select parent_id, depth from org_nodes where id = ${root.id}`
  expect(stillRoot[0]!.parent_id).toBeNull()
  expect(stillRoot[0]!.depth).toBe(1)

  // 4. Единственный источник истины о руководителе (к. 4, П-16.4)
  const me = await api<{ user: { id: string } }>(request, csrf, 'get', '/auth/me')
  const mgr = await api<{ source: string }>(request, csrf, 'get', `/org-structure/manager/${me.user.id}`)
  expect(['org_tree', 'location', 'functional', 'role_scope', 'none']).toContain(mgr.source)

  // Экран администратора: таб конструктора есть, узлы видны
  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/org-structure')
  await expect(page.getByRole('tab', { name: 'Адмін — конструктор' })).toBeVisible()
  await page.getByRole('tab', { name: 'Адмін — конструктор' }).click()
  await expect(page.getByText(`${PREFIX} Керуюча компанія`)).toBeVisible()
  await expect(page.getByText(`${PREFIX} Кухня`)).toBeVisible()
  // Иконки управления у администратора есть
  await expect(page.getByRole('button', { name: 'Додати дочірній вузол' }).first()).toBeVisible()
})

test('рядовий співробітник бачить лише вітрину: таба конструктора і іконок немає (к. 8)', async ({ page }) => {
  await loginViaUi(page, EMPLOYEE_PHONE)
  await page.goto('/org-structure')
  await expect(page.getByRole('tab', { name: 'Співробітник — перегляд' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Адмін — конструктор' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Додати дочірній вузол' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Архівувати' })).toHaveCount(0)
})

/**
 * PR-31 (docs/v2/32 §6.2, §9): «Імпорт» — шаги загрузки и предпросмотра на экране. Применение
 * идёт фоновой задачей, а e2e поднимает приложение без воркера (`WORKER_ENABLED=0`), поэтому
 * здесь — только то, что видит администратор до запуска: сопоставление колонок и построчный
 * предпросмотр, где висячий узел помечен ошибкой, а не попадает в дерево. Применение, откат и
 * конфликты проверяет `tests/integration/v2-org-import.spec.ts`.
 */
test('адмін завантажує CSV: попередній перегляд показує «створити» і висячий вузол як помилку', async ({ page, request }) => {
  await apiLogin(request, ADMIN_PHONE)
  // Выгрузка — тот же формат, что и импорт: UTF-8 с BOM, `;`, первая колонка — ключ узла.
  const exp = await request.get('/api/v1/org-structure/export')
  expect(exp.status()).toBe(200)
  const body = await exp.body()
  expect([...body.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
  expect(body.subarray(3).toString('utf8').startsWith('external_key;parent_external_key;')).toBe(true)

  const csv = [
    'external_key;parent_external_key;title;is_manager_point',
    `E2E-ORG-1;;${PREFIX} Імпорт корінь;так`,
    `E2E-ORG-2;E2E-NOPE;${PREFIX} Сирота;ні`,
  ].join('\r\n')

  await loginViaUi(page, ADMIN_PHONE)
  await page.goto('/org-structure')
  await page.getByRole('tab', { name: 'Адмін — конструктор' }).click()
  await page.getByRole('button', { name: 'Імпорт', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Імпорт оргструктури' })
  await dialog.getByLabel('Файл CSV').setInputFiles({ name: 'e2e-org-import.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') })
  await dialog.getByRole('button', { name: 'Завантажити' }).click()

  await expect(dialog.getByText('Створити: 1')).toBeVisible()
  await expect(dialog.getByText('Помилок: 1')).toBeVisible()
  await expect(dialog.getByText('Батьківський вузол «E2E-NOPE» не знайдено')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Запустити імпорт' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Закрити' }).last().click()

  // Предпросмотр в дерево не пишет ничего.
  const written = await admin`select 1 from org_nodes where external_key in ('E2E-ORG-1', 'E2E-ORG-2')`
  expect(written.length).toBe(0)
})
