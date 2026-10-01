import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `docs/v2/32` §10 «мутации идемпотентны по `Idempotency-Key`» и `41` §5.3 (публикация на
 * площадку — ключ обязателен): сторож, чтобы новая ручка оргструктуры не забыла обёртку
 * `idempotent()` (`v2/44` Р-CC.5).
 */

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

describe('Р-CC.5: Idempotency-Key у мутаций оргструктуры и публикации вакансии', () => {
  it('каждая мутация /org-structure вызывает idempotent() после проверки прав', () => {
    const files = walk('server/api/v1/org-structure').filter(f => /\.(post|put|patch|delete)\.ts$/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(13)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/return idempotent\(event, a, async \(\) => \{/)
      expect(src.indexOf('requireScope('), f).toBeLessThan(src.indexOf('idempotent(event'))
    }
  })

  it('публикация на площадку требует ключ (required: true)', () => {
    const src = readFileSync('server/api/v1/vacancies/[id]/publications.post.ts', 'utf8')
    expect(src).toMatch(/\}, \{ required: true \}\)/)
  })

  it('клиент шлёт ключ во всех мутациях оргструктуры и в публикации вакансии', () => {
    const files = [...walk('app/components').filter(f => /\/Org[A-Za-z]+\.vue$/.test(f)), 'app/pages/org-structure/index.vue', 'app/pages/admin/vacancies/[id].vue']
    let calls = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/api(?:<[^>]*>)?\(\s*[`'][^`']*\/(?:org-structure\/[^`']*|vacancies\/\$\{id\}\/publications)[`'],\s*\{([^}]*)/g)) {
        if (!/method: '(POST|PUT|PATCH|DELETE)'/.test(m[1]!)) continue
        calls++
        expect(m[1], `${f}: ${m[0].slice(0, 80)}`).toMatch(/idempotent: true/)
      }
    }
    expect(calls).toBeGreaterThanOrEqual(14)
  })
})
