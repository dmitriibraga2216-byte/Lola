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

  /**
   * Сквозная проверка 13 (`docs/v2/42-stages-delta.md` §5, инвариант 1 `29` §1): вакансия
   * хранит шаблон параметров, а не правила прохождения. Две фикстуры: собственный ключ
   * правил в схеме вакансии — нарушение; тот же ключ внутри шаблона параметров — нет.
   */
  it('7. правило прохождения заведено прямо в схеме вакансии', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'shared/schemas'), { recursive: true })
    writeFileSync(join(dir, 'shared/schemas/vacancies.ts'), 'export const s = { pass_score: 70 }\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('7. вакансия не носитель правил прохождения')
  })

  it('7. тот же ключ внутри шаблона параметров нарушением не считается', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'shared/schemas'), { recursive: true })
    writeFileSync(join(dir, 'shared/schemas/vacancies.ts'), 'export const s = { assignmentTemplate: { pass_score: 70 } }\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   7.')
  })

  /**
   * Сквозная проверка 22 (`docs/v2/42-stages-delta.md` §5, `37` §7.10): время обучения —
   * биениями. Статический сторож: колонки учёта пишет только свёртка `learningTimeRollup.ts`.
   * Три фикстуры: «открыл — закрыл» в сервисе, то же через Drizzle — нарушения; чтение — нет.
   */
  it('11. время попытки посчитано разницей «открыл — закрыл» в сервисе', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/bad.ts'), 'export const q = sql`update attempts set net_seconds = extract(epoch from submitted_at - started_at)::int`\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('11. время обучения пишет только свёртка биений')
  })

  it('11. колонку учёта пишет не свёртка, а Drizzle-запрос сервиса', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/bad.ts'), 'export async function f(tx) { await tx.update(lessonProgress).set({ contentSeconds: 600 }) }\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('11. время обучения')
  })

  it('11. чтение колонок учёта и их ограничения нарушением не считаются', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    mkdirSync(join(dir, 'server/db/migrations'), { recursive: true })
    writeFileSync(join(dir, 'server/services/ok.ts'), 'export const cols = { netSeconds: attempts.netSeconds, contentSeconds: q.contentSeconds }\n')
    writeFileSync(join(dir, 'server/db/migrations/9999_ok.sql'), 'ALTER TABLE x ADD CONSTRAINT c CHECK ("content_seconds" >= 0 AND "attempt_seconds" >= 0);\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   11.')
  })

  /**
   * Проверка 12 (PR-39, `docs/v2/44` В-20, `docs/v2/39` П-21): права Bearer читает одно место —
   * `access.ts`; таблицу объявлений платформы — один модуль. Три фикстуры: ручка со своим
   * «списком путей» для токена и лента новостей, подмешавшая объявления, — нарушения; сам
   * модуль объявлений и комментарий — нет.
   */
  it('12. ручка сама решает по токену — начало чёрного списка путей', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/api/v1/people'), { recursive: true })
    writeFileSync(join(dir, 'server/api/v1/people/notes.get.ts'), 'export default (event) => { if (event.context.tokenScopes) throw new Error("no") }\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('12. Bearer разграничен только скоупами')
  })

  it('12. лента новостей тенанта подмешивает объявления платформы', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/news.ts'), 'export const q = sql`select title from news union all select title from platform_announcements`\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('12. Bearer разграничен только скоупами, лента платформы — один модуль')
  })

  it('12. модуль объявлений, схема и комментарий нарушением не считаются', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    mkdirSync(join(dir, 'server/db/schema'), { recursive: true })
    writeFileSync(join(dir, 'server/services/platformAnnouncements.ts'), 'export const q = tx.select().from(platformAnnouncements)\n')
    writeFileSync(join(dir, 'server/db/schema/platform.ts'), "export const platformAnnouncements = pgTable('platform_announcements', {})\n")
    writeFileSync(join(dir, 'server/services/access.ts'), 'const t = event.context.tokenScopes\n')
    writeFileSync(join(dir, 'server/services/other.ts'), '// лента новостей не читает platform_announcements и tokenScopes\nexport const x = 1\n')
    const res = run(dir)
    expect(res.stdout).toContain('[ok]   12.')
  })

  it('6. объяснение запрета в комментарии не считается нарушением', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/ok.ts'), '// ни truncate, ни delete from review_queue_items\nexport const x = 1\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   6.')
  })
  /**
   * Сквозная проверка 16 (`docs/v2/42` §5, решение В-9 п. 2): главный риск публичного
   * контура. Три фикстуры: обработчик, сам лезущий в БД; обработчик без частотного
   * ограничения; и правильный обработчик — тонкий и с `hitRateLimit`.
   */
  it('8. обработчик публичного контура обращается к БД сам', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/api/v1/public/j'), { recursive: true })
    writeFileSync(join(dir, 'server/api/v1/public/j/bad.get.ts'), `
      import { db } from '../../../../db/client'
      import { hitRateLimit } from '../../../../services/rateLimit'
      export default defineEventHandler(async () => { await hitRateLimit('k', 1, 1); return db.select() })
    `)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('8. публичный контур')
  })

  it('8. обработчик публичного контура без hitRateLimit', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/api/v1/public/j'), { recursive: true })
    writeFileSync(join(dir, 'server/api/v1/public/j/bad.get.ts'), `
      import { publicVacancy } from '../../../../services/publicApply'
      export default defineEventHandler(async () => publicVacancy('t', { ip: '1' }))
    `)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('8. публичный контур')
  })

  it('8. тонкий обработчик с частотным ограничением нарушением не считается', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/api/v1/public/j'), { recursive: true })
    writeFileSync(join(dir, 'server/api/v1/public/j/ok.get.ts'), `
      import { publicVacancy } from '../../../../services/publicApply'
      import { hitRateLimit } from '../../../../services/rateLimit'
      export default defineEventHandler(async () => {
        if (!await hitRateLimit('k', 30, 600)) return null
        return publicVacancy('t', { ip: '1' })
      })
    `)
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   8.')
  })

  /**
   * Сквозная проверка 9 (`docs/v2/39-patches.md` П-16.4, `docs/v2/32` §7.8): руководитель
   * человека берётся только `resolveManager()`. Три фикстуры: новое чтение
   * `locations.manager_id` в сервисе — нарушение; то же чтение внутри самого
   * `orgManager.ts` — не нарушение (там источник и живёт); объяснение правила
   * в комментарии — тоже не нарушение.
   */
  it('9. руководитель человека читается мимо resolveManager()', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/bad.ts'), 'export const q = "select l.manager_id from locations l"\n')
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('9. руководитель человека мимо resolveManager()')
  })

  it('9. то же чтение внутри orgManager.ts нарушением не считается', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/orgManager.ts'), 'export const q = "select l.manager_id from locations l"\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   9.')
  })

  it('9. объяснение правила в комментарии не считается нарушением', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/ok.ts'), '// адресат из resolveManager(), а не locations.manager_id\nexport const x = 1\n')
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   9.')
  })

  /**
   * Сквозная проверка 19 (`docs/v2/42-stages-delta.md` §5, П-23): тихие часы кандидата
   * безусловны (не смотрят на тумблер тенанта) и используют его собственное окно
   * 09:00–20:00, а не сотрудницкое. Полное поведение по времени — интеграционный тест
   * (нужна БД); здесь — статический инвариант на исходник enqueueNotification().
   */
  it('10. ветка кандидата отсутствует вовсе', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/notifications.ts'), `
export async function enqueueNotification(tx, input) {
  const settings = readSettings()
  if (settings.quietHours.enabled) scheduledFor = scheduleWithQuietHours(now, tz, settings.quietHours)
  else scheduledFor = now
}
`)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('10. тихие часы кандидата')
    expect(res.stdout).toContain('не различает kind==candidate')
  })

  it('10. ветка кандидата проверяет тумблер тенанта quietHours.enabled', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/notifications.ts'), `
export async function enqueueNotification(tx, input) {
  const settings = readSettings()
  if (recipient?.kind === 'candidate') {
    if (settings.quietHours.enabled) scheduledFor = scheduleWithQuietHours(now, tz, CANDIDATE_QUIET_HOURS)
    else scheduledFor = now
  }
  else {
    scheduledFor = now
  }
}
`)
    const res = run(dir)
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('обязаны быть безусловными')
  })

  it('10. ветка кандидата безусловна и использует своё окно — проходит', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'server/services'), { recursive: true })
    writeFileSync(join(dir, 'server/services/notifications.ts'), `
export async function enqueueNotification(tx, input) {
  if (recipient?.kind === 'candidate') {
    scheduledFor = scheduleWithQuietHours(now, tz, CANDIDATE_QUIET_HOURS)
  }
  else {
    scheduledFor = now
  }
}
`)
    const res = run(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('[ok]   10.')
  })
})
