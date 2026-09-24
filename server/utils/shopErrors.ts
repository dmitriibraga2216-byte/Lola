import type { ItemError } from '../services/shop'

/** Тексты ошибок формы подарка: объясняют, что сделать (Definition of Done: «ошибки объясняют, что делать»). */
export function itemErrorMessage(code: ItemError): string {
  switch (code) {
    case 'not_found': return 'Подарунок не знайдено — можливо, його вже видалили'
    case 'category_not_found': return 'Такої категорії немає — оберіть категорію зі списку'
    case 'location_not_found': return 'Такої точки немає — оберіть точку видачі зі списку або «будь-яка»'
    case 'image_not_found': return 'Зображення не знайдено — завантажте його ще раз'
  }
}
