import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../../server/services/svgSanitize'
import { countPdfPages } from '../../server/jobs/mediaProcess'

/** D-011 (docs/28 Spec 11 «Лимиты файлов»): SVG на входе чистится по allowlist. D-006: страницы PDF по байтам. */
describe('sanitizeSvg', () => {
  const evil = `<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY x "y">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50" onload="alert(1)">
  <script>alert(1)</script>
  <defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <rect width="100" height="50" fill="url(#g)" style="fill:url(http://evil/x);stroke:red" onclick="alert(2)"/>
  <rect fill="url(http://evil/x.svg#a)"/>
  <a xlink:href="javascript:alert(1)"><text x="1" y="2">hi &amp; &lt;b&gt;</text></a>
  <a href="https://ok.example/"><text>ok</text></a>
  <use xlink:href="http://evil/x.svg#a"/><use href="#g"/>
  <image href="data:image/png;base64,AAAA"/><image href="https://ok/x.png"/>
  <foreignObject><body><img src=x onerror=alert(1)></body></foreignObject>
  <animate attributeName="x" from="0" to="1"/>
  <style>rect{fill:red} @import url(http://e); g{fill:url(#g)} .x{background:url(http://e/x.png)}</style>
  <style>&lt;/style&gt;&lt;script&gt;alert(3)&lt;/script&gt;</style>
</svg>`

  it('вырезает script, foreignObject, анимации, on*, javascript:/data:, внешние use/url()', () => {
    const r = sanitizeSvg(evil)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.svg
    expect(out).not.toMatch(/<script|foreignObject|<animate|onload|onclick|onerror|javascript:|data:|evil|@import|DOCTYPE|ENTITY/i)
    // Полезное остаётся: градиент, локальные ссылки, безопасные http-ссылки, текст с сущностями
    expect(out).toContain('fill="url(#g)"')
    expect(out).toContain('<use href="#g">')
    expect(out).toContain('href="https://ok.example/"')
    expect(out).toContain('href="https://ok/x.png"')
    expect(out).toContain('hi &amp; &lt;b&gt;')
    expect(out).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /)
  })

  it('стили сохраняются без @import и внешних url(); текст style не может закрыть тег', () => {
    const r = sanitizeSvg(evil)
    if (!r.ok) throw new Error('not svg')
    const style = r.svg.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    expect(style).toContain('rect{fill:red}')
    expect(style).toContain('g{fill:url(#g)}')
    expect(style).toContain('background:none')
    expect(style).not.toContain('<')
    expect(r.svg.match(/<style>/g)?.length).toBe(1)
    expect(r.svg.match(/<\/style>/g)?.length).toBe(1)
  })

  it('обычный экспорт проходит без потерь', () => {
    const r = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z" fill="#0aa" stroke-width="1.5"/></svg>')
    expect(r.ok && r.svg).toContain('<path d="M12 2L2 7l10 5 10-5-10-5z" fill="#0aa" stroke-width="1.5">')
  })

  it('не-SVG (HTML под видом svg) — отказ', () => {
    expect(sanitizeSvg('<html><body><script>alert(1)</script></body></html>')).toEqual({ ok: false, reason: 'not_svg' })
    expect(sanitizeSvg('<p>текст</p><svg/>').ok).toBe(false)
  })
})

describe('countPdfPages', () => {
  it('берёт /Count у /Type /Pages, иначе считает объекты /Type /Page', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n', 'latin1')
    expect(countPdfPages(pdf)).toBe(3)
    // Порядок ключей другой, вложенные узлы Pages — берётся максимум
    expect(countPdfPages(Buffer.from('<< /Count 7 /Type /Pages >> << /Type /Pages /Count 4 /Parent 1 0 R >>'))).toBe(7)
    // Нет /Pages — по объектам страниц (без /Pages и /PageMode)
    expect(countPdfPages(Buffer.from('<< /Type /Page >> << /Type /Page >> << /PageMode /UseNone >> << /Type/Page >>'))).toBe(3)
    // Сжатый каталог — ничего не видно
    expect(countPdfPages(Buffer.from('%PDF-1.5 binary only'))).toBeNull()
  })
})
