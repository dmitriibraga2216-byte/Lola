import { describe, expect, it } from 'vitest'
import { checklistItemsFromText, compactBody, isBlockEmpty } from '../../shared/domain/contentBlocks'
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

/**
 * Замечание 27.09, п. 2: пункт чек-листа ввели в textarea — при сохранении «Щось пішло не так».
 * Причины: перевод строки съедался (пункты склеивались), пустой пункт/чек-лист без пунктов
 * падал на zod с английским текстом, без подсказки, что делать.
 */
describe('чек-лист — пункты из textarea и понятные ошибки', () => {
  it('по пункту на строку; пустые строки и пробелы по краям отбрасываются, перевод строки не склеивает пункты', () => {
    expect(checklistItemsFromText('Пункт один\n')).toEqual(['Пункт один'])
    expect(checklistItemsFromText('Пункт один\n\n  Пункт два  \n')).toEqual(['Пункт один', 'Пункт два'])
    expect(checklistItemsFromText('')).toEqual([])
  })

  it('compactBody: пустой чек-лист исчезает, у заполненного — только непустые пункты', () => {
    const body: ContentBlock[] = [
      { id: 'c0', type: 'checklist', items: [''], requireAll: true },
      { id: 'c1', type: 'checklist', items: [' Каса ', '', 'Термінал'], requireAll: true },
    ]
    expect(compactBody(body)).toEqual([{ id: 'c1', type: 'checklist', items: ['Каса', 'Термінал'], requireAll: true }])
    expect(bodySchema.safeParse(compactBody(body)).success).toBe(true)
  })

  it('ошибки схемы — по-украински и говорят, что сделать', () => {
    const msg = (items: string[]) => {
      const r = bodySchema.safeParse([{ id: 'c', type: 'checklist', items, requireAll: true }])
      return r.success ? '' : r.error.issues[0]!.message
    }
    expect(msg([])).toMatch(/впишіть хоча б один пункт.*або видаліть блок/)
    expect(msg(['  '])).toMatch(/порожній пункт/)
    expect(msg(['x'.repeat(501)])).toMatch(/скоротіть/)
    expect(msg(Array.from({ length: 31 }, (_, i) => `п${i}`))).toMatch(/не більше 30/)
  })
})
