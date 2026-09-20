import sanitizeHtml from 'sanitize-html'

/**
 * Санитизация SVG при загрузке (docs/11 §3.4, docs/28 Spec 11 «Лимиты файлов», D-011).
 * Файлы отдаются напрямую из S3 по подписанной ссылке, поэтому хранимый XSS в SVG режется
 * на входе: allowlist тегов и атрибутов (`sanitize-html` в XML-режиме), без `script`,
 * `foreignObject`, анимаций и `on*`; `href`/`xlink:href` — только http(s) у ссылок и картинок
 * и только `#id` у `use`; `url(...)` в заливках/стилях — только локальные `#id`; `data:` и
 * `javascript:` не проходят. Результат сохраняется вместо оригинала.
 */

const SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch', 'view',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'image', 'a', // `style` — отдельно, см. extractStyles
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]

const SVG_ATTRS = [
  'id', 'class', 'style', 'lang', 'role', 'aria-label', 'aria-labelledby', 'aria-hidden',
  'xmlns', 'xmlns:xlink', 'xml:space', 'xml:lang', 'version', 'baseProfile',
  'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength',
  'transform', 'transform-origin', 'href', 'xlink:href', 'xlink:title',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color',
  'display', 'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask', 'filter',
  'marker-start', 'marker-mid', 'marker-end', 'paint-order', 'vector-effect', 'pointer-events',
  'shape-rendering', 'text-rendering', 'image-rendering', 'color-interpolation', 'color-interpolation-filters',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'letter-spacing', 'word-spacing', 'text-anchor', 'text-decoration', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'unicode-bidi', 'direction', 'writing-mode', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust',
  'startOffset', 'method', 'spacing',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'mode', 'type', 'values', 'tableValues',
  'slope', 'intercept', 'amplitude', 'exponent', 'k1', 'k2', 'k3', 'k4', 'operator', 'order',
  'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLength',
  'surfaceScale', 'diffuseConstant', 'specularConstant', 'specularExponent', 'lighting-color',
  'flood-color', 'flood-opacity', 'azimuth', 'elevation', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'limitingConeAngle', 'stdDeviation', 'radius', 'scale', 'xChannelSelector', 'yChannelSelector',
  'baseFrequency', 'numOctaves', 'seed', 'stitchTiles',
]

const HREF_ATTRS = ['href', 'xlink:href']
/** `url(...)` допускается только на локальный id — внешние ресурсы из заливок/масок/стилей не грузятся. */
const EXTERNAL_URL = /url\(\s*['"]?\s*(?!#)/i
/** Внутри `<style>` и `style=""` — ни выражений, ни скриптовых схем; `@import` и внешние `url()` режет cleanCss. */
const DANGEROUS_CSS = /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none')
}

/**
 * Блоки `<style>` вынимаются до разбора и вставляются обратно одним блоком: `sanitize-html`
 * отдаёт текст `style` как есть (в XML-режиме сущности уже раскрыты — `&lt;/style&gt;` стал бы
 * закрывающим тегом). Из CSS убираются `@import`, внешние `url()` и все `<`, `>`, `&`.
 */
function extractStyles(input: string): { rest: string, css: string } {
  const parts: string[] = []
  const rest = input.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css: string) => {
    const body = css.replace(/<!\[CDATA\[|\]\]>/g, '')
    if (!DANGEROUS_CSS.test(body)) parts.push(cleanCss(body).replace(/[<>&]/g, ''))
    return ''
  })
  return { rest, css: parts.join('\n').trim() }
}

function cleanAttribs(tagName: string, attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(attribs)) {
    if (HREF_ATTRS.includes(name)) {
      const v = value.trim()
      // use/textPath/pattern/gradient/filter/mask/clipPath ссылаются только внутрь документа
      if (tagName !== 'a' && tagName !== 'image' && !v.startsWith('#')) continue
      if (/^\s*(javascript|data|vbscript):/i.test(v)) continue
      out[name] = v
      continue
    }
    if (name === 'style') {
      if (DANGEROUS_CSS.test(value)) continue
      out[name] = cleanCss(value)
      continue
    }
    if (EXTERNAL_URL.test(value)) continue
    out[name] = value
  }
  return out
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: SVG_TAGS,
  allowedAttributes: { '*': SVG_ATTRS },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: HREF_ATTRS,
  allowProtocolRelative: false,
  parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false, decodeEntities: true },
  disallowedTagsMode: 'discard',
  transformTags: { '*': (tagName, attribs) => ({ tagName, attribs: cleanAttribs(tagName, attribs) }) },
}

export type SvgSanitizeResult = { ok: true, svg: string } | { ok: false, reason: 'not_svg' }

/** Возвращает очищенный SVG или отказ, если после чистки корня `<svg>` нет. */
export function sanitizeSvg(input: string): SvgSanitizeResult {
  // DOCTYPE \u0441 \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u043C \u043F\u043E\u0434\u043C\u043D\u043E\u0436\u0435\u0441\u0442\u0432\u043E\u043C (ENTITY \u2014 \u00ABbillion laughs\u00BB, \u0432\u043D\u0435\u0448\u043D\u0438\u0435 \u0441\u0443\u0449\u043D\u043E\u0441\u0442\u0438) \u043F\u0430\u0440\u0441\u0435\u0440 XML-\u0440\u0435\u0436\u0438\u043C\u0430
  // \u0440\u0435\u0436\u0435\u0442 \u043F\u043E \u043F\u0435\u0440\u0432\u043E\u043C\u0443 \u00AB>\u00BB, \u043E\u0441\u0442\u0430\u0432\u043B\u044F\u044F \u0445\u0432\u043E\u0441\u0442 \u0442\u0435\u043A\u0441\u0442\u043E\u043C \u2014 \u0443\u0431\u0438\u0440\u0430\u0435\u043C \u0446\u0435\u043B\u0438\u043A\u043E\u043C \u0434\u043E \u0440\u0430\u0437\u0431\u043E\u0440\u0430
  const { rest, css } = extractStyles(input.replace(/^\uFEFF/, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, ''))
  let cleaned = sanitizeHtml(rest, OPTIONS).trim()
  if (!/^<svg[\s>]/.test(cleaned)) return { ok: false, reason: 'not_svg' }
  if (css) cleaned = cleaned.replace(/^(<svg\b[^>]*>)/, `$1<style>${css}</style>`)
  return { ok: true, svg: `<?xml version="1.0" encoding="UTF-8"?>\n${cleaned}` }
}
