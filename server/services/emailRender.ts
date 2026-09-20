/**
 * Рендер листа з `body_mjml` (docs/23 §3.1, §13.4) — без mjml-компілятора (CLAUDE.md «не додавати
 * залежностей»; рішення зафіксоване в docs/28 «Spec 23»): підтримуємо безпечне підмножина тегів
 * MJML, яких зазвичай достатньо для листа-сповіщення (секція/колонка/текст/кнопка/картинка/розділювач),
 * і компілюємо їх у прості інлайн-стилізовані `<div>`/`<p>`/`<a>` — не повний layout-движок справжнього
 * MJML.
 *
 * Докс/33 D-048: секція з ≥2 `<mj-column>` компілюється в `<table>` з `<td>` на колонку (ширина —
 * атрибут `width` колонки або рівний поділ), а не просто «розгортається» в один стовпець як раніше —
 * це і є спосіб зробити колонки в HTML-листі без компілятора. Одна колонка (або без колонок) —
 * як і раніше, просто `<div>`. Проста медіа-точка (`breakpoint`) у `buildEmailHtml` складає колонки
 * в один стовпець на вузьких екранах у клієнтах, що підтримують `<style>` у листі (докс/33 D-048:
 * «breakpoints/колонки → таблиці» — зроблено в межах підмножини, без `mj-social` і вкладених layout).
 * Довг, що лишається: справжня компіляція MJML (`mj-social`, вкладені колонки з довільним layout,
 * повноцінні breakpoints для всіх клієнтів) — не робимо, `mjml` як пакет не додавали.
 *
 * Якщо `body_mjml` порожній або в ньому взагалі немає розпізнаних `<mj-*>` тегів — фолбек:
 * беремо текст (`body_text` після рендеру змінних) і показуємо його як прості абзаци.
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** true, если строка похожа на MJML-разметку (есть хоть один поддерживаемый тег). */
export function looksLikeMjml(src: string): boolean {
  return /<mj-(section|column|text|button|image|divider|spacer)\b/i.test(src)
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'))
  return m ? m[1]! : null
}

/**
 * Компилирует безопасное подмножество MJML в HTML. Всё, что не входит в белый список тегов,
 * вырезается как разметка (текст внутри остаётся) — почтовые клиенты не должны получить произвольный HTML.
 */
export function renderMjmlSubset(mjml: string): string {
  let src = mjml
    .replace(/<\/?mjml[^>]*>/gi, '')
    .replace(/<mj-head[\s\S]*?<\/mj-head>/gi, '')
    .replace(/<\/?mj-body[^>]*>/gi, '')

  src = src.replace(/<mj-image\b([^>]*)\/?>(?:<\/mj-image>)?/gi, (_, a: string) => {
    const src2 = attr(a, 'src') ?? ''
    const alt = attr(a, 'alt') ?? ''
    const width = attr(a, 'width')
    return `<img src="${esc(src2)}" alt="${esc(alt)}" style="max-width:100%;display:block;margin:0 auto;${width ? `width:${esc(width)};` : ''}">`
  })
  src = src.replace(/<mj-divider\b[^>]*\/?>(?:<\/mj-divider>)?/gi, '<hr style="border:none;border-top:1px solid #E6DACA;margin:16px 0">')
  src = src.replace(/<mj-spacer\b([^>]*)\/?>(?:<\/mj-spacer>)?/gi, (_, a: string) => `<div style="height:${esc(attr(a, 'height') ?? '20px')}"></div>`)
  src = src.replace(/<mj-button\b([^>]*)>([\s\S]*?)<\/mj-button>/gi, (_, a: string, inner: string) => {
    const href = attr(a, 'href') ?? '#'
    return `<p style="margin:16px 0"><a href="${esc(href)}" style="display:inline-block;background:#F4B740;color:#0C0F14;padding:10px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-family:Nunito,Arial,sans-serif">${inner.trim()}</a></p>`
  })
  src = src.replace(/<mj-text\b[^>]*>([\s\S]*?)<\/mj-text>/gi, (_, inner: string) => `<p style="margin:0 0 12px;font-family:Nunito,Arial,sans-serif;color:#0C0F14;line-height:1.5">${inner.trim()}</p>`)

  // Секція: ≥2 колонки → таблиця з <td> на колонку (докс/33 D-048), інакше — як раніше, просто <div>.
  src = src.replace(/<mj-section\b[^>]*>([\s\S]*?)<\/mj-section>/gi, (_, inner: string) => {
    const columns = [...inner.matchAll(/<mj-column\b([^>]*)>([\s\S]*?)<\/mj-column>/gi)]
    if (columns.length >= 2) {
      const equalWidth = `${(100 / columns.length).toFixed(2)}%`
      const cells = columns.map((c) => {
        const width = attr(c[1] ?? '', 'width') ?? equalWidth
        return `<td class="mj-col" valign="top" style="width:${esc(width)};padding:0 8px">${(c[2] ?? '').trim()}</td>`
      }).join('')
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse"><tr>${cells}</tr></table>`
    }
    return `<div style="padding:12px 0">${inner.replace(/<\/?mj-column[^>]*>/gi, '')}</div>`
  })

  // Невідомі mj-* теги (наприклад mj-social — лишається довгом, компілятор не підключали) прибираємо
  // як розмітку, текст усередині лишаємо — інваріант «безпечний список тегів» з докс/28 «Spec 23».
  src = src.replace(/<\/?mj-[a-z-]+(?:\s[^>]*)?>/gi, '')
  return src.trim()
}

/** Стиль медіа-точки для табличних колонок (докс/33 D-048): у клієнтах, що читають <style> в тілі, колонки складаються в один стовпець на вузьких екранах. */
const COLUMN_BREAKPOINT_STYLE = '<style>@media only screen and (max-width:480px){.mj-col{display:block!important;width:100%!important;padding:0 0 12px!important}}</style>'

/** Фолбек: обычный текст → абзацы (перенос строки = новый абзац), с экранированием. */
export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px;font-family:Nunito,Arial,sans-serif;color:#0C0F14;line-height:1.5">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

export interface EmailLayoutInput { headerMjml?: string, footerMjml?: string }

/**
 * Собирает HTML письма: тело шаблона (mjml-подмножество или текстовый фолбек) + шапка/подвал
 * тенанта (docs/23 §13.5), обёрнутые в бежевый фон бренд-бука. `{{mail_settings_url}}` в футере
 * гарантирует наличие ссылки на настройки — рендерится вызывающим кодом вместе с остальными переменными.
 */
export function buildEmailHtml(input: { bodyMjml: string | null, fallbackText: string, layout?: EmailLayoutInput }): string {
  const bodyHtml = input.bodyMjml && looksLikeMjml(input.bodyMjml) ? renderMjmlSubset(input.bodyMjml) : textToHtml(input.fallbackText)
  const header = input.layout?.headerMjml ? (looksLikeMjml(input.layout.headerMjml) ? renderMjmlSubset(input.layout.headerMjml) : textToHtml(input.layout.headerMjml)) : ''
  const footer = input.layout?.footerMjml ? (looksLikeMjml(input.layout.footerMjml) ? renderMjmlSubset(input.layout.footerMjml) : textToHtml(input.layout.footerMjml)) : ''
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#E6DACA;font-family:Nunito,Arial,sans-serif">`
    + COLUMN_BREAKPOINT_STYLE
    + `<div style="max-width:600px;margin:0 auto;background:#FAF6EC;border-radius:16px;padding:24px">`
    + header + bodyHtml + footer
    + `</div></body></html>`
}
