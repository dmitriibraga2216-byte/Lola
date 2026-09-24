import type { H3Event } from 'h3'
import type { DocWriteError, TypeWriteError } from '../services/personDocuments'
import { apiError } from './apiResponse'

/** Коды ошибок документов человека (docs/v2/38 §6.2, §10; `docs/v2/41` §4.12) — одна таблица на ручки. */
export function documentWriteError(event: H3Event, r: DocWriteError) {
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Документ, файл або людину не знайдено')
    case 'forbidden': return apiError(event, 403, 'forbidden', 'Немає права на документи цього типу для цієї людини')
    case 'document_type_invalid': return apiError(event, 422, 'document_type_invalid', 'Оберіть тип документа')
    case 'document_file_not_allowed': return apiError(event, 422, 'document_file_not_allowed', 'Для цього типу документа зберігається лише факт наявності — файл не додається')
    case 'document_file_required': return apiError(event, 422, 'document_file_required', 'Додайте скан документа')
    case 'document_file_invalid': return apiError(event, 422, 'document_file_invalid', 'Дозволені формати: PDF, JPG, PNG, до 20 МБ')
    case 'document_file_not_ready': return apiError(event, 422, 'document_file_not_ready', 'Файл ще не завантажено до кінця — спробуйте ще раз')
    case 'document_dates_invalid': return apiError(event, 422, 'document_dates_invalid', r.reason === 'issued_in_future'
      ? 'Дата видачі не може бути в майбутньому'
      : r.reason === 'expires_required' ? 'Для цього типу вкажіть, до якої дати документ дійсний' : 'Дата закінчення має бути пізніше дати видачі', { reason: r.reason })
    case 'document_revoked': return apiError(event, 409, 'document_revoked', 'Документ відкликано — змінити можна лише примітку')
    case 'document_is_evidence': return apiError(event, 409, 'document_is_evidence', 'Документ обовʼязкового типу є доказом і не видаляється — відкличте його з причиною')
    case 'reason_required': return apiError(event, 422, 'reason_required', 'Вкажіть причину відкликання')
  }
}

export function documentTypeWriteError(event: H3Event, r: TypeWriteError) {
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Тип документа не знайдено')
    case 'forbidden': return apiError(event, 403, 'forbidden', 'Довідник типів документів змінює HR')
    case 'code.exists': return apiError(event, 409, 'code.exists', 'Тип з таким кодом уже є')
    case 'type_is_system': return apiError(event, 409, 'type_is_system', 'Системний тип не видаляється — його можна вимкнути')
    case 'type_in_use': return apiError(event, 409, 'type_in_use', `Тип використовується у ${r.count} документах — вимкніть його замість видалення`, { count: r.count })
  }
}
