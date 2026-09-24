import type { H3Event } from 'h3'
import type { NoteWriteError } from '../services/personNotes'
import { apiError } from './apiResponse'

/**
 * Коды ошибок записи заметки (docs/v2/38 §10, `docs/v2/41` §4.12) — одна таблица на три ручки.
 * `sensitive` — не отказ, а просьба подтвердить (§6.1, §7.5): в `details` признаки и слова,
 * форма показывает «Текст схожий на чутливі дані…», повтор с `confirmSensitive` сохраняет.
 */
export function noteWriteError(event: H3Event, r: NoteWriteError) {
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Нотатку або людину не знайдено')
    case 'forbidden': return apiError(event, 403, 'forbidden', 'Немає права писати або змінювати цю нотатку')
    case 'person_archived': return apiError(event, 409, 'person_archived', 'Співробітника звільнено — нотатки доступні лише для читання')
    case 'note_archived': return apiError(event, 409, 'note_archived', 'Нотатку перенесено до архіву за строком зберігання — її не змінюють')
    case 'pinned_limit': return apiError(event, 409, 'pinned_limit', 'Не більше трьох закріплених нотаток')
    case 'visibility_narrowing_forbidden': return apiError(event, 409, 'visibility_narrowing_forbidden', 'Нотатку вже показано співробітнику — звузити видимість не можна')
    case 'reason_required': return apiError(event, 422, 'reason_required', 'Вкажіть причину видалення чужої нотатки')
    case 'sensitive': return apiError(event, 409, 'note_sensitive_suspected', 'Текст схожий на чутливі дані. Переконайтеся, що нотатка стосується роботи й навчання', { signs: r.signs, terms: r.terms })
  }
}
