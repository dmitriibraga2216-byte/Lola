import { describe, expect, it } from 'vitest'
import { compactBody, isBlockEmpty } from '../../shared/domain/contentBlocks'
import { bodySchema, type ContentBlock } from '../../shared/schemas/content'

/**
 * Замечание администратора 27.09: в редакторе «Сторінка» три пустых блока «Заголовок» подряд.
 * Пустые блоки — незаполненные заготовки, в ресурс они не сохраняются.
 */
describe('compactBody — пустые блоки не сохраняются', () => {
  it('три пустых заголовка подряд исчезают, заполненный остаётся', () => {
    const body: ContentBlock[] = [
      { id: 'h1', type: 'heading', level: 2, text: '' },
      { id: 'h2', type: 'heading', level: 2, text: '   ' },
      { id: 'h3', type: 'heading', level: 3, text: 'Видача замовлення' },
    ]
    expect(compactBody(body).map(b => b.id)).toEqual(['h3'])
  })

  it('пустой текст, цитата, виноска, медиа без файла и embed без id — пустые', () => {
    const empty: ContentBlock[] = [
      { id: 't', type: 'text', html: '<p></p>' },
      { id: 't2', type: 'text', html: '<p>&nbsp;</p>' },
      { id: 'q', type: 'quote', text: '' },
      { id: 'c', type: 'callout', tone: 'info', text: '' },
      { id: 'i', type: 'image', mediaId: '', alt: '', width: 'full' },
      { id: 'v', type: 'video', mediaId: '', allowSeek: true },
      { id: 'f', type: 'file', mediaId: '', name: '' },
      { id: 'e', type: 'embed', provider: 'youtube', videoId: '' },
    ]
    for (const b of empty) expect(isBlockEmpty(b), b.id).toBe(true)
    expect(compactBody(empty)).toEqual([])
  })

  it('розділювач и виноска только с заголовком — не пустые', () => {
    const body: ContentBlock[] = [
      { id: 'd', type: 'divider' },
      { id: 'c', type: 'callout', tone: 'warn', title: 'Увага', text: '' },
    ]
    expect(compactBody(body)).toEqual(body)
  })

  it('результат проходит схему тела', () => {
    const body: ContentBlock[] = [
      { id: 'h1', type: 'heading', level: 2, text: '' },
      { id: 'h2', type: 'heading', level: 2, text: 'Крок 1' },
    ]
    expect(bodySchema.safeParse(body).success).toBe(true)
    expect(bodySchema.safeParse(compactBody(body)).success).toBe(true)
  })
})
