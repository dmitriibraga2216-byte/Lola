import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CLAUDE.md п. 8: тексты только через i18n. Этот тест ловит обратную ошибку —
 * ключ используется в компоненте, но не описан в словаре (на экране видно «notif.title»).
 * Проверяются статические вызовы t('a.b.c'); динамические (t(`x.${y}`)) — только корень.
 */
const root = resolve(__dirname, '../..')
const uk = JSON.parse(readFileSync(join(root, 'i18n/locales/uk.json'), 'utf8')) as Record<string, unknown>
const en = JSON.parse(readFileSync(join(root, 'i18n/locales/en.json'), 'utf8')) as Record<string, unknown>
const ru = JSON.parse(readFileSync(join(root, 'i18n/locales/ru.json'), 'utf8')) as Record<string, unknown>

function has(dict: Record<string, unknown>, key: string): boolean {
  let cur: unknown = dict
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as object)) cur = (cur as Record<string, unknown>)[part]
    else return false
  }
  return true
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

describe('i18n: ключи компонентов есть в словарях', () => {
  const files = walk(join(root, 'app'))
  const staticKeys = new Set<string>()
  const dynamicRoots = new Set<string>()
  for (const f of files) {
    const s = readFileSync(f, 'utf8')
    for (const m of s.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9_.]+)'/g)) staticKeys.add(m[1]!)
    for (const m of s.matchAll(/\bt\(`([a-zA-Z][a-zA-Z0-9_.]*)\.\$\{/g)) dynamicRoots.add(m[1]!)
  }

  it('находит ключи в приложении', () => {
    expect(staticKeys.size).toBeGreaterThan(200)
  })

  it('все статические ключи есть в uk.json', () => {
    const missing = [...staticKeys].filter(k => !has(uk, k)).sort()
    expect(missing, `нет в uk.json: ${missing.join(', ')}`).toEqual([])
  })

  it('все статические ключи есть в en.json', () => {
    const missing = [...staticKeys].filter(k => !has(en, k)).sort()
    expect(missing, `нет в en.json: ${missing.join(', ')}`).toEqual([])
  })

  it('все статические ключи есть в ru.json', () => {
    const missing = [...staticKeys].filter(k => !has(ru, k)).sort()
    expect(missing, `нет в ru.json: ${missing.join(', ')}`).toEqual([])
  })

  it('корни динамических ключей существуют', () => {
    const missing = [...dynamicRoots].filter(k => !has(uk, k)).sort()
    expect(missing, `нет корня в uk.json: ${missing.join(', ')}`).toEqual([])
  })
})
