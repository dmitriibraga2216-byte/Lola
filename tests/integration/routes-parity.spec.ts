import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkParity } from './_routesParity'

/**
 * Паритет путей с docs/04-api.md (spec-04-routes, docs/28 «Spec 04», docs/30 «Б» п. 18).
 *
 * Разбирает таблицы путей `04` и сверяет каждый метод+путь с файлами-обработчиками в
 * server/api/v1 (напрямую или через алиас — `export { default } from …` /
 * `aliasHandler()` дают тот же шаблон маршрута, что и настоящий эндпоинт).
 *
 * Пути, для которых обработчика ещё нет (класс «в» — долг, см. docs/28 «Spec 04»),
 * не валят тест — они печатаются как todo. Тест падает только если путь, который
 * был покрыт на момент этого PR (`fixtures/routes-parity.baseline.json`), пропадает —
 * то есть на регресс уже сделанного алиаса. Полное снятие старых путей — отдельный
 * PR в конце R1 (docs/30 «Б» п. 18); тогда же обновляется и baseline.
 *
 * docs/05-screens.md путей экранов не перечисляет (только поведение и раскладку),
 * поэтому сверка страниц по образцу docs/04 не строится — сверять не с чем
 * (см. docs/28 «Spec 04»); `app/pages/{admin,learn}/*` не переименовывались.
 */

const DOC_PATH = resolve(__dirname, '../../docs/04-api.md')
const API_ROOT = resolve(__dirname, '../../server/api/v1')
const BASELINE_PATH = resolve(__dirname, './fixtures/routes-parity.baseline.json')

const md = readFileSync(DOC_PATH, 'utf8')
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as string[]
const { covered, missing } = checkParity(md, API_ROOT)

describe('Паритет маршрутов с docs/04-api.md (spec-04-routes)', () => {
  it('парсер находит таблицы путей (санити-чек)', () => {
    expect(covered.length + missing.length).toBeGreaterThan(300)
  })

  it('печатает пути без обработчика как todo (не блокирует PR, см. docs/28 «Spec 04»)', () => {
    if (missing.length) {
      console.info(`[routes-parity] docs/04 без обработчика в server/api/v1 — todo (${missing.length}):\n${missing.join('\n')}`)
    }
    expect(missing).toEqual(expect.any(Array))
  })

  it('уже покрытые пути не пропадают (регресс алиасов spec-04-routes)', () => {
    const coveredSet = new Set(covered)
    const regressed = baseline.filter(p => !coveredSet.has(p))
    expect(regressed, `пропали обработчики для: ${regressed.join(', ')}`).toEqual([])
  })
})
