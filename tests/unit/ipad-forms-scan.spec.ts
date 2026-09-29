import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { personListQuerySchema } from '../../shared/schemas/people'

/**
 * Проход администратора по формам на iPad (docs/v2/46-progress.md, запись 2026-09-29).
 * Статические проверки классов ошибок, которые не должны вернуться:
 *
 * 1. Клиент просит у `GET /people` больше, чем разрешает серверная схема (`limit` > max) —
 *    сервер отвечает 400, `.catch(() => [])` глотает ответ, и обязательный список «Людина» /
 *    «Власник» / «Відповідальний» остаётся пустым без объяснения.
 * 2. Пустое поле даты в Safari не имеет собственной ширины — глобальный минимум в `ui.css`.
 */

const root = resolve(__dirname, '../..')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? vueFiles(p) : p.endsWith('.vue') ? [p] : []
  })
}

describe('iPad: формы администратора', () => {
  it('ни один экран не просит у /people больше, чем разрешает personListQuerySchema', () => {
    const offenders: string[] = []
    const calls = /['"`]\/people(?:\?[^'"`]*)?['"`][^\n]*?limit[=:]\s*(\d+)/g
    let found = 0
    for (const file of vueFiles(join(root, 'app'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(calls)) {
        found++
        const limit = Number(m[1])
        if (!personListQuerySchema.safeParse({ limit }).success) {
          const line = src.slice(0, m.index).split('\n').length
          offenders.push(`${relative(root, file)}:${line} — limit ${limit}`)
        }
      }
    }
    expect(found).toBeGreaterThan(5) // регулярка ещё находит вызовы
    expect(offenders).toEqual([])
  })

  it('поля даты и даты-времени имеют минимальную ширину и высоту (пустое поле в Safari сжимается)', () => {
    const css = readFileSync(join(root, 'app/assets/ui.css'), 'utf8')
    for (const type of ['date', 'month', 'datetime-local']) {
      const rule = css.split('}').find(r => r.includes(`input[type="${type}"]`))
      expect(rule, type).toBeDefined()
      expect(rule, type).toMatch(/min-width:\s*min\(\d+em, \d+vw\)/)
      expect(rule, type).toMatch(/min-height:/)
    }
  })
})
