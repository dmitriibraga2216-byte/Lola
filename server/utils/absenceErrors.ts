import type { H3Event } from 'h3'
import type { AbsenceWriteError } from '../services/absences'
import { apiError } from './apiResponse'

/** Коды ошибок записей отсутствий (docs/v2/38 §6.4, §10) — одна таблица на ручки. */
export function absenceWriteError(event: H3Event, r: AbsenceWriteError) {
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Людину або запис про відсутність не знайдено')
    case 'forbidden': return apiError(event, 403, 'forbidden', 'Відсутності цієї людини веде HR або керівник її точки')
    case 'person_archived': return apiError(event, 409, 'person_archived', 'Співробітника звільнено — його відсутності лише для перегляду')
    case 'absence_cancelled': return apiError(event, 409, 'absence_cancelled', 'Запис скасовано — змінити його не можна, внесіть новий')
    case 'absence_status_invalid': return apiError(event, 409, 'absence_status_invalid', 'Статус змінюється лише вперед: «Заплановано» → «Підтверджено» → «Скасовано»', { from: r.from, to: r.to })
    case 'absence_record.range_invalid': return apiError(event, 422, 'absence_record.range_invalid', r.reason === 'order'
      ? 'Дата закінчення не може бути раніше дати початку'
      : 'Період — не довше року; довшу відсутність внесіть кількома записами', { reason: r.reason })
    case 'absence_overlap': return apiError(event, 409, 'absence_overlap', 'Відсутність перетинається з наявним записом — змініть період', { conflict: r.conflict })
  }
}
