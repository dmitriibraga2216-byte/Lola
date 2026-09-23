import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Полная сверка трёх словарей интерфейса (docs/00 «Языки интерфейса», CLAUDE.md п. 8):
 * одинаковый набор ключей во всех трёх, никаких пустых значений, одинаковый набор
 * плейсхолдеров `{...}` в каждом ключе. `i18n-keys.spec.ts` проверяет только то, что
 * реально используется в компонентах (`t('a.b.c')`); здесь — весь словарь целиком,
 * включая ключи, до которых компонентный греп не дотягивается (динамические t(`code.${x}`)).
 */
const root = resolve(__dirname, '../..')
const LOCALES = ['uk', 'en', 'ru'] as const

function loadDict(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, `i18n/locales/${locale}.json`), 'utf8')) as Record<string, unknown>
}

/** Плоский объект `dotted.key -> значение`; массивы — как есть (листья), не разворачиваются. */
function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else out[key] = v
  }
  return out
}

const dicts = Object.fromEntries(LOCALES.map(l => [l, flatten(loadDict(l))])) as Record<typeof LOCALES[number], Record<string, unknown>>

/** Плейсхолдеры вида `{name}`, включая экранированные `{'{{'}1{'}}'}` — как непрозрачные подстроки, не разбираем их изнутри. */
function placeholders(value: unknown): string[] {
  return [...String(value).matchAll(/\{[^}]*\}/g)].map(m => m[0]).sort()
}

describe('i18n: три словаря (uk/en/ru) синхронны', () => {
  const ukKeys = Object.keys(dicts.uk).sort()

  it('uk.json не пуст и реально содержит ключи', () => {
    expect(ukKeys.length).toBeGreaterThan(1000)
  })

  for (const locale of LOCALES) {
    if (locale === 'uk') continue

    it(`${locale}.json содержит ровно те же ключи, что uk.json (не больше и не меньше)`, () => {
      const otherKeys = Object.keys(dicts[locale]).sort()
      const missing = ukKeys.filter(k => !(k in dicts[locale]))
      const extra = otherKeys.filter(k => !(k in dicts.uk))
      expect(missing, `нет в ${locale}.json: ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? '…' : ''}`).toEqual([])
      expect(extra, `лишние в ${locale}.json: ${extra.slice(0, 30).join(', ')}${extra.length > 30 ? '…' : ''}`).toEqual([])
    })

    it(`${locale}.json: ни одного пустого значения там, где в uk.json оно не пусто`, () => {
      const empties = ukKeys.filter((k) => {
        const ukVal = dicts.uk[k]
        const otherVal = dicts[locale][k]
        return ukVal !== '' && (otherVal === '' || otherVal === null || otherVal === undefined)
      })
      expect(empties, `пустые значения в ${locale}.json: ${empties.slice(0, 30).join(', ')}`).toEqual([])
    })

    it(`${locale}.json: у каждого ключа тот же набор плейсхолдеров {…}, что в uk.json`, () => {
      const mismatches = ukKeys
        .filter(k => k in dicts[locale])
        .map(k => ({ key: k, uk: placeholders(dicts.uk[k]), other: placeholders(dicts[locale][k]) }))
        .filter(({ uk, other }) => JSON.stringify(uk) !== JSON.stringify(other))
        .map(({ key, uk, other }) => `${key}: uk=${JSON.stringify(uk)} ${locale}=${JSON.stringify(other)}`)
      expect(mismatches, `несовпадающие плейсхолдеры:\n${mismatches.slice(0, 30).join('\n')}`).toEqual([])
    })
  }
})
