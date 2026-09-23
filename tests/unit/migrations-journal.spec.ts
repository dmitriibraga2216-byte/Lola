import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Drizzle применяет миграцию только если её `when` больше `created_at` последней применённой
 * (`pg-core/dialect.js`: `lastDbMigration.created_at < migration.folderMillis`). Значит миграция
 * с меньшим `when`, чем у предыдущей, **молча пропускается** на базе, где предыдущая уже накачена:
 * на чистой БД (CI) всё проходит, а на стенде и проде схема тихо остаётся старой.
 * Так случилось 23.09 с 0053 (параллельные ветки выставили `when` из разного времени).
 */
describe('журнал миграций', () => {
  const journal = JSON.parse(readFileSync('server/db/migrations/meta/_journal.json', 'utf8')) as {
    entries: { idx: number, when: number, tag: string }[]
  }

  it('when строго возрастает — иначе drizzle пропустит миграцию на накаченной БД', () => {
    const broken = journal.entries
      .map((e, i) => ({ prev: journal.entries[i - 1], cur: e }))
      .filter(p => p.prev && p.cur.when <= p.prev.when)
      .map(p => `${p.prev!.tag} (${p.prev!.when}) → ${p.cur.tag} (${p.cur.when})`)
    expect(broken, `when не возрастает: ${broken.join('; ')}`).toEqual([])
  })

  it('idx идут подряд и совпадают с порядком записей', () => {
    expect(journal.entries.map(e => e.idx)).toEqual(journal.entries.map((_, i) => i))
  })

  /**
   * docs/v2/45-plan.md, PR-01, условие выхода: «порядок when совпадает с порядком idx/tag».
   * idx уже проверен выше (порядок записей = 0..N). Здесь — что тег (числовой префикс имени
   * миграции) идёт в том же порядке, что и запись в журнале: расхождение означало бы, что
   * миграция с префиксом NNNN стоит не на своём месте в истории применения.
   */
  it('порядок when совпадает с порядком tag', () => {
    const byTag = [...journal.entries].sort((a, b) => a.tag.localeCompare(b.tag))
    expect(journal.entries.map(e => e.tag)).toEqual(byTag.map(e => e.tag))
  })
})
