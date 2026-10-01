import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CLAUDE.md правило 9: «магических отступов нет» (docs/v2/44 §18 Р-CC.4). В `<style scoped>`
 * отступ — `padding*`, `margin*`, `gap`, `row-gap`, `column-gap` — задаётся только токенами
 * `--space-*` (или их `calc()`), без литерала `px`. Размеры (ширина, высота, минимальная зона
 * касания 44px), толщина рамки и точки перелома медиазапросов — не отступы и сюда не входят.
 * Сторож закрывает долг PR-01 (проверка 5 `scripts/v2-crosschecks.sh` была сужена из-за него).
 */

const root = resolve(__dirname, '../..')

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? vueFiles(p) : p.endsWith('.vue') ? [p] : []
  })
}

const SCOPED = /<style[^>]*\bscoped\b[^>]*>([\s\S]*?)<\/style>/g
const SPACING_DECL = /(?<![-\w])((?:padding|margin)(?:-[a-z-]+)?|gap|row-gap|column-gap)\s*:\s*([^;}]*)/g
const PX = /(?<![\w.-])\d+(?:\.\d+)?px\b/

/** Строки `<style scoped>` с отступом в px: «файл:строка свойство: значение». */
export function spacingPxOffenders(file: string, source: string): string[] {
  const out: string[] = []
  for (const block of source.matchAll(SCOPED)) {
    const blockStart = block.index! + block[0].indexOf(block[1]!)
    const css = block[1]!.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    for (const d of css.matchAll(SPACING_DECL)) {
      if (!PX.test(d[2]!)) continue
      const line = source.slice(0, blockStart + d.index!).split('\n').length
      out.push(`${file}:${line} ${d[1]}: ${d[2]!.trim()}`)
    }
  }
  return out
}

describe('отступы в <style scoped> — только токены бренд-бука', () => {
  const files = vueFiles(join(root, 'app'))
  const tokens = readFileSync(join(root, 'app/assets/tokens.css'), 'utf8')
  const defined = new Set([...tokens.matchAll(/(--space-[\w-]+)\s*:/g)].map(m => m[1]))

  it('ни одного px в padding/margin/gap', () => {
    const offenders = files.flatMap(f => spacingPxOffenders(relative(root, f), readFileSync(f, 'utf8')))
    expect(offenders, `отступ в px вместо var(--space-*):\n${offenders.join('\n')}`).toEqual([])
  })

  it('каждый var(--space-*) объявлен в tokens.css', () => {
    const unknown = new Set<string>()
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/var\((--space-[\w-]+)/g)) {
        if (!defined.has(m[1]!)) unknown.add(`${relative(root, f)}: ${m[1]}`)
      }
    }
    expect([...unknown]).toEqual([])
  })

  it('сторож ловит нарушения и не трогает размеры и рамки', () => {
    const src = `<template><div/></template>
<style scoped>
.a { padding: 2px var(--space-2); border: 1px solid var(--color-bg-line); min-height: 44px; }
.b { margin-left: 6px; width: 120px; }
.c { gap: calc(var(--space-1) + 3px); }
/* padding: 4px — в комментарии не считается */
.d { padding: var(--space-1); --label-w: 110px; }
@media (max-width: 640px) { .e { column-gap: var(--space-2); } }
</style>
<style>.global { padding: 3px; }</style>`
    expect(spacingPxOffenders('x.vue', src)).toEqual([
      'x.vue:3 padding: 2px var(--space-2)',
      'x.vue:4 margin-left: 6px',
      'x.vue:5 gap: calc(var(--space-1) + 3px)',
    ])
  })
})
