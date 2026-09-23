import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * docs/v2/45-plan.md, PR-01: `scripts/v2-crosschecks.sh` обязан возвращать 0 на текущем `main`
 * и ненулевой код на искусственном нарушении — для каждой из пяти сквозных проверок отдельно
 * (HANDOFF §7.3). Проверяется здесь, а не только «на глаз»: пять фикстур с единственным
 * внесённым нарушением каждая, плюс запуск против самого репозитория.
 */

const SCRIPT = resolve(__dirname, '../../scripts/v2-crosschecks.sh')

function run(root: string) {
  return spawnSync('bash', [SCRIPT, root], { encoding: 'utf8' })
}

const dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2-crosschecks-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('scripts/v2-crosschecks.sh — на реальном репозитории', () => {
  it('возвращает 0 на текущем main', () => {
    const res = run(resolve(__dirname, '../..'))
    expect(res.stdout + res.stderr, res.stdout + res.stderr).toMatch(/\[ok\]|\[skip\]/)
    expect(res.status, res.stdout + res.stderr).toBe(0)
  })
})

describe('scripts/v2-crosschecks.sh — падает на искусственном нарушении каждой проверки', () => {
  it('1. код этапа вне справочника/миграций', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/bad.ts'), `
      export function branch(code: string) {
        if (code === 'attestation') return true
        return false
      }
    `)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('1. коды этапов')
  })

  it('2. выборка users без фильтра kind (после появления репозиторного слоя)', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services/repo'), { recursive: true })
    writeFileSync(join(dir, 'server/services/repo/people.ts'), 'export function employeesQuery() {}\n')
    writeFileSync(join(dir, 'server/services/audience.ts'), `
      import { db } from '../db/client'
      export async function listAll() { return db.select().from(users) }
    `)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('2. выборки users без фильтра kind')
  })

  it('2. без репозиторного слоя проверка пропускается (не может дать ложный красный)', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/audience.ts'), `
      import { db } from '../db/client'
      export async function listAll() { return db.select().from(users) }
    `)
    const res = run(dir)
    expect(res.stdout).toContain('[skip] 2.')
  })

  it('3. прямое подключение драйвера мимо withTenant()', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    // Импорт должен начинаться с колонки 0 — так пишутся все top-level импорты в репозитории
    // (docs/07 §Definition of Done), и именно так работает `^import ...` в самом скрипте.
    writeFileSync(join(dir, 'server/services/bad.ts'), "import postgres from 'postgres'\nconst client = postgres('postgres://x')\n")
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('3. прямое подключение драйвера')
  })

  it('4. строка интерфейса мимо i18n', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'app/pages'), { recursive: true })
    writeFileSync(join(dir, 'app/pages/bad.vue'), '<template>\n  <button>Зберегти</button>\n</template>\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('4. строка интерфейса мимо i18n')
  })

  it('5. цвет и отступ мимо токенов', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'app/pages'), { recursive: true })
    writeFileSync(
      join(dir, 'app/pages/bad.vue'),
      '<template>\n  <div style="padding: 12px">x</div>\n</template>\n<style scoped>\n.x { color: #ff00aa; }\n</style>\n',
    )
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('5. цвет/отступ мимо токенов')
  })

  /**
   * Сквозная проверка 21 (`docs/v2/42-stages-delta.md` §5, решение В-2): очередь проверки
   * поддерживается, а не пересобирается. Две фикстуры: удаление в коде и удаление в миграции —
   * плюс отдельная проверка, что объяснение запрета в комментарии нарушением не считается.
   */
  it('6. очередь проверки пересобирается в коде', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/bad.ts'), 'export async function rebuild(tx) { await tx.delete(reviewQueueItems) }\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('6. очередь проверки не пересоздаётся')
  })

  it('6. очередь пересобирается миграцией', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/db/migrations'), { recursive: true })
    writeFileSync(join(dir, 'server/db/migrations/9999_rebuild.sql'), 'DELETE FROM review_queue_items;\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('6. очередь проверки не пересоздаётся')
  })

  it('6. объяснение запрета в комментарии не считается нарушением', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/ok.ts'), '// ни truncate, ни delete from review_queue_items\nexport const x = 1\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   6.')
  })
})
