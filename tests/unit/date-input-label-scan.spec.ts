import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Поле даты не внутри `<label>` (замечание 27.09, docs/v2/46-progress.md, запись 2026-09-29).
 * В iPad Safari тап по дню в календаре нативного `input[type=date|datetime-local|month]`, обёрнутого
 * в `<label>`, уходит в label и закрывает выбор — выбирались только месяц и год. Подпись — соседний
 * `<label for>`, обёртка — `<div class="… date-label">`; «Дата народження» — `DateSelect` (#155).
 *
 * Исключение — только файлы, которые правит другая задача, с причиной.
 */

const root = resolve(__dirname, '../..')

const EXCEPTIONS: Record<string, string> = {
  'app/pages/admin/knowledge/[id].vue': 'База знань — правится отдельной задачей (замечания 27.09), поле «Переглянути до» в списке 46-progress',
}

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? vueFiles(p) : p.endsWith('.vue') ? [p] : []
  })
}

describe('iPad: поле даты не обёрнуто в <label>', () => {
  it('ни одного input[type=date|datetime-local|month] внутри <label>', () => {
    const offenders: string[] = []
    for (const file of vueFiles(join(root, 'app'))) {
      const rel = relative(root, file)
      if (EXCEPTIONS[rel]) continue
      const src = readFileSync(file, 'utf8')
      const start = src.indexOf('<template')
      if (start < 0) continue
      const tpl = src.slice(start)
      for (const m of tpl.matchAll(/<input\b[^>]*\btype="(?:date|datetime-local|month)"/g)) {
        const before = tpl.slice(0, m.index)
        if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) {
          offenders.push(`${rel}:${src.slice(0, start).split('\n').length + before.split('\n').length - 1}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('исключения указывают на существующие файлы', () => {
    for (const f of Object.keys(EXCEPTIONS)) expect(() => statSync(join(root, f)), f).not.toThrow()
  })
})
