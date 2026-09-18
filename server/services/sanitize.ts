import sanitizeHtml from 'sanitize-html'
import type { ContentBlock } from '../../shared/schemas/content'

/**
 * Санитизация HTML на сервере при сохранении (docs/11 §7.9, docs/06 §6.6):
 * allowlist тегов и атрибутов, всё прочее вырезается; ссылки получают
 * rel="noopener noreferrer".
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'br',
    'sup', 'sub', 'blockquote', 'code', 'table', 'thead', 'tbody', 'tr',
    'th', 'td', 'h2', 'h3', 'h4', 'span',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    span: ['style'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedStyles: {
    span: { color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/] },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
  disallowedTagsMode: 'discard',
}

export function sanitizeUserHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS)
}

/** Прогоняет все text-блоки тела урока через санитайзер. */
export function sanitizeBody(body: ContentBlock[]): ContentBlock[] {
  return body.map(block =>
    block.type === 'text' ? { ...block, html: sanitizeUserHtml(block.html) } : block,
  )
}
