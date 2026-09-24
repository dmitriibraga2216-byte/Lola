import type { H3Event } from 'h3'
import type { ZodError } from 'zod'
import { apiError } from './apiResponse'

/**
 * Коды ответов библиотеки модулей (`docs/v2/31` §10; PR-25) — одна таблица на все ручки
 * `/library/*`, чтобы один и тот же отказ не получал два текста в двух эндпоинтах.
 *
 * «Нет скоупа» — одно написание `forbidden` (`docs/v2/44` В-16 §8.2.7): причина отказа
 * уходит в `details.reason`, а не в код. Чужой тенант — `404` (CLAUDE.md п. 15): сервис под
 * RLS строку не находит и отвечает `not_found`. Каждый текст объясняет, что делать (DoD).
 */
const LIBRARY_ERRORS = {
  not_found: [404, 'not_found', 'Модуль не знайдено'],
  holder_not_found: [404, 'not_found', 'Вузол або урок не знайдено в цьому треку чи курсі'],
  usage_not_found: [404, 'not_found', 'Місце використання не знайдено'],
  proposal_not_found: [404, 'not_found', 'Пропозицію не знайдено'],
  lesson_not_found: [404, 'not_found', 'Урок не знайдено'],
  forbidden: [403, 'forbidden', 'Зверніться до власника модуля: редагувати можуть його автори'],
  container_forbidden: [403, 'container.forbidden', 'Немає прав редагувати цей трек або курс'],
  module_archived: [409, 'module_archived', 'Модуль заархівовано — спершу відновіть його'],
  module_not_published: [409, 'module_not_published', 'Модуль ще не опубліковано: вставляється лише опублікована версія'],
  module_not_archived: [409, 'module_not_archived', 'Модуль не в архіві'],
  in_use: [409, 'library_module.in_use', 'Модуль використовується. Видалити не можна — його можна заархівувати'],
  slug_taken: [409, 'slug_taken', 'Модуль із таким кодом уже є — змініть код'],
  already_attached: [409, 'already_attached', 'Модуль уже підключено до цього місця'],
  already_detached: [409, 'already_detached', 'Це місце вже відʼєднано'],
  container_published: [409, 'container.published', 'Опубліковані трек або версію курсу не змінюють: відкрийте чернетку в редакторі'],
  proposal_pending: [409, 'proposal_pending', 'Цей урок уже запропоновано, рішення ще не ухвалено'],
  already_in_library: [409, 'already_in_library', 'Цей урок уже посилається на модуль бібліотеки'],
  already_decided: [409, 'proposal.already_decided', 'Рішення вже прийнято'],
  owner_forbidden: [422, 'owner_forbidden', 'У цієї людини немає прав на бібліотеку'],
  category_not_found: [422, 'category_not_found', 'Категорію видалено, оберіть іншу'],
  too_many_authors: [422, 'too_many_authors', 'Не більше 10 авторів разом із власником'],
  empty_body: [422, 'empty_body', 'Додайте вміст: хоча б один блок, а для файлу, відео чи посилання — сам файл або посилання'],
  media_not_ready: [422, 'media_not_ready', 'Дочекайтеся обробки файлів і опублікуйте ще раз'],
  holder_not_content: [422, 'holder_not_content', 'Модуль вставляється у вузол-завдання, а не в логіку графа'],
  not_content: [422, 'not_content', 'У бібліотеку пропонують лише матеріал: тести перевикористовуються банком питань'],
} as const satisfies Record<string, readonly [number, string, string]>

export type LibraryErrorKey = keyof typeof LIBRARY_ERRORS

export function libraryFail(event: H3Event, key: LibraryErrorKey, details?: Record<string, unknown>, message?: string) {
  const [status, code, text] = LIBRARY_ERRORS[key]
  return apiError(event, status, code, message ?? text, details)
}

/**
 * Отказ валидации (`422`, §10). Поле, у которого в §10 свой код, отвечает им: пустой
 * «Що змінилось» — `changelog_required`, «Причина» архива — `reason_required`, комментарий
 * отказа — `comment_required`. Текст — первого замечания схемы: он написан для формы (§6).
 */
const FIELD_CODES: Record<string, string> = {
  changelog: 'changelog_required',
  reason: 'reason_required',
  decisionComment: 'comment_required',
}

export function libraryValidationFail(event: H3Event, error: ZodError, fallback = 'Перевірте поля форми') {
  const first = error.issues[0]
  const field = typeof first?.path[0] === 'string' ? first.path[0] : ''
  return apiError(event, 422, FIELD_CODES[field] ?? 'validation_failed', first?.message ?? fallback, { issues: error.issues })
}
