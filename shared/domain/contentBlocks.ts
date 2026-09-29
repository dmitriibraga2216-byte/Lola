import type { ContentBlock } from '../schemas/content'

/**
 * Пустые блоки контента не сохраняются (замечание администратора 27.09, docs/11 §3.3):
 * блок «Заголовок» без текста, чек-лист без пунктов, картинка без файла и т. п. — это
 * заготовка, которую добавили и не заполнили. Редактор держит их, пока человек пишет;
 * перед сохранением форма пропускает тело через `compactBody()`.
 */

/** Пункты чек-листа из textarea «по пункту на рядок»: пробелы по краям и пустые строки — прочь. */
export function checklistItemsFromText(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}

function blank(s: string | null | undefined): boolean {
  return !s || !s.trim()
}

/** Текст блока «Текст» без тегов и `&nbsp;` — `<p></p>` пустой. */
function htmlBlank(html: string): boolean {
  return blank(html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '))
}

export function isBlockEmpty(block: ContentBlock): boolean {
  switch (block.type) {
    case 'heading': return blank(block.text)
    case 'text': return htmlBlank(block.html)
    case 'callout': return blank(block.text) && blank(block.title)
    case 'quote': return blank(block.text)
    case 'checklist': return block.items.every(blank)
    case 'image':
    case 'video':
    case 'file': return !block.mediaId
    case 'embed': return blank(block.videoId)
    case 'divider': return false
  }
}

/** Тело к сохранению: без пустых блоков, у чек-листов — только непустые пункты без пробелов по краям. */
export function compactBody(body: ContentBlock[]): ContentBlock[] {
  return body
    .filter(b => !isBlockEmpty(b))
    .map(b => (b.type === 'checklist' ? { ...b, items: b.items.map(s => s.trim()).filter(Boolean) } : b))
}
