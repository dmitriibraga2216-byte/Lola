import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Условие выхода PR-36 (`docs/v2/45-plan.md`): **одна формула эффективного лимита** на баннер
 * и на счёт. Лимит хранилища считает только `server/services/tenantLimits.ts`
 * (`effectiveLimits()` / `checkLimit()` / `graceOf()`, решение `docs/v2/44` В-5, риск Р-6);
 * сервисы хранилища знают только факт — сколько занято.
 *
 * Тест читает исходники и падает, если в сервисе хранилища появилось то, из чего собирается
 * вторая формула: тариф (`plans`, `max_storage_gb`), переопределение (`tenant_limits`,
 * `storage_gb`), опции (`tenant_addons`, `plan_addons`, `unit_step`) или своё число допуска.
 * Интеграционная сторона того же условия — `v2-storage-quota.spec.ts` («одна формула»).
 */
const root = resolve(__dirname, '../..')
const servicesDir = join(root, 'server/services')
const STORAGE_SERVICES = readdirSync(servicesDir).filter(f => /^storage.*\.ts$/.test(f))

const FORBIDDEN = [
  /\btenant_addons\b/, /\btenantAddons\b/, /\bplan_addons\b/, /\bplanAddons\b/,
  /\bmax_storage_gb\b/, /\bmaxStorageGb\b/, /\bstorage_gb\b/, /\bstorageGb\b/,
  /\btenant_limits\b/, /\btenantLimits\b(?!\.ts|')/, /\bunit_step\b/, /\bunitStep\b/,
  /\bfrom\s+plans\b/, /STORAGE_GRACE_PCT/, /\b0\.02\b/,
]

describe('PR-36: в сервисах хранилища нет второй формулы квоты', () => {
  it('сервисы хранилища найдены', () => {
    expect(STORAGE_SERVICES).toEqual(expect.arrayContaining(['storage.ts', 'storageDeletion.ts', 'storagePending.ts', 'storagePolicies.ts']))
  })

  for (const file of STORAGE_SERVICES) {
    it(`${file}: лимит только из tenantLimits.ts`, () => {
      const code = readFileSync(join(servicesDir, file), 'utf8')
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*\*)/.test(line)) // комментарии объясняют правило — это не нарушение
        .join('\n')
      const hits = FORBIDDEN.filter(re => re.test(code)).map(re => re.source)
      expect(hits, `${file} собирает лимит сам: ${hits.join(', ')}`).toEqual([])
    })
  }

  it('допуск для начатых загрузок живёт рядом с формулой лимита', () => {
    const limits = readFileSync(join(servicesDir, 'tenantLimits.ts'), 'utf8')
    expect(limits).toMatch(/export function graceOf\(/)
    expect(limits).toMatch(/withGrace/)
  })
})
