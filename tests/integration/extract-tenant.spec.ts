import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Smoke-тест `scripts/extract-tenant.ts` (docs/25 §11, §16.3; docs/33 D-058) на dev-БД:
 * дамп реального тенанта во все таблицы с tenant_id, порядок — по зависимостям,
 * `--anonymize` вычищает персональные столбцы и не трогает результаты обучения.
 */
process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { createTenant, ensureFirstAdmin, platformLogin, validatePlatformSession } = await import('../../server/services/platform')
const { purgeTenantData } = await import('../../server/services/platformTenants')

const OPS_EMAIL = 'ops-extract@lola.local'
const OPS_PASSWORD = 'test-password-123'
const stamp = Date.now().toString(36)

let tenantId: string
let opsAuth: { adminId: string, email: string, fullName: string }
let outDir: string
let adminStatus: string

beforeAll(async () => {
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await ensureFirstAdmin()
  opsAuth = (await validatePlatformSession((await platformLogin(OPS_EMAIL, OPS_PASSWORD))!.token))!
  const r = await createTenant({ slug: `ext-${stamp}`, name: 'Виг Тест', adminPhone: '+380501234500', adminName: 'Ганна Виговська', plan: 'trial' }, opsAuth)
  if (!r.ok) throw new Error('не удалось создать тестовый тенант')
  tenantId = r.tenantId
  outDir = mkdtempSync(join(tmpdir(), 'extract-tenant-'))
}, 30_000)

afterAll(async () => {
  if (tenantId) await purgeTenantData(tenantId, opsAuth).catch(() => {})
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

function run(args: string[]) {
  return spawnSync('node_modules/.bin/tsx', ['scripts/extract-tenant.ts', ...args], { encoding: 'utf8', env: process.env })
}

describe('scripts/extract-tenant.ts', () => {
  it('выгружает тенанта во все таблицы с tenant_id, порядок манифеста — родители раньше детей', () => {
    const res = run([tenantId, '--out', outDir, '--skip-media'])
    expect(res.status, res.stderr).toBe(0)
    const dir = res.stdout.match(/выгружен в (\S+):/)?.[1]
    expect(dir).toBeTruthy()
    const manifest = JSON.parse(readFileSync(join(dir!, 'manifest.json'), 'utf8'))
    expect(manifest.tenantId).toBe(tenantId)
    expect(manifest.anonymized).toBe(false)
    expect(manifest.tableOrder.indexOf('users')).toBeLessThan(manifest.tableOrder.indexOf('enrollments'))
    /**
     * Цикл `users.candidate_status_id ↔ candidate_statuses.created_by` — настоящий
     * (docs/v2/44-decisions.md В-13, PR-13): порядка создания, снимающего его, не существует.
     * Выгрузка обязана разорвать его **нулевой** ссылкой и назвать разорванное в манифесте,
     * а не сбросить обе таблицы в хвост: `users` позади своих детей — это выгрузка, из
     * которой нельзя восстановиться, и внешне она выглядит целой.
     */
    expect(manifest.deferredRefs).toContainEqual({ table: 'users', column: 'candidate_status_id', references: 'candidate_statuses' })
    expect(manifest.tableOrder.indexOf('users')).toBeLessThan(manifest.tableOrder.indexOf('candidate_statuses'))
    expect(manifest.rowCounts.users).toBeGreaterThanOrEqual(1)
    const users = JSON.parse(readFileSync(join(dir!, 'users.json'), 'utf8'))
    const admin = users.find((u: { full_name: string }) => u.full_name === 'Ганна Виговська')
    expect(admin).toBeTruthy()
    adminStatus = admin.status
  })

  it('--anonymize вычищает персональные столбцы, не трогая статус и роль', () => {
    const res = run([tenantId, '--out', outDir, '--skip-media', '--anonymize'])
    expect(res.status, res.stderr).toBe(0)
    const dir = res.stdout.match(/выгружен в (\S+):/)?.[1]
    const manifest = JSON.parse(readFileSync(join(dir!, 'manifest.json'), 'utf8'))
    expect(manifest.anonymized).toBe(true)
    const users = JSON.parse(readFileSync(join(dir!, 'users.json'), 'utf8'))
    const admin = users[0]
    expect(admin.full_name).not.toBe('Ганна Виговська')
    expect(admin.full_name).toMatch(/^Людина \d+$/)
    expect(admin.phone).toBeNull()
    expect(admin.email).toBeNull()
    expect(admin.status).toBe(adminStatus) // статус/результат не трогаем — обезличиваем только личность
  })
})
