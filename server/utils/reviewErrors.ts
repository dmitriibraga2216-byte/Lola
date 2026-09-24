import type { DelegateError, ReassignError, RevokeError } from '../services/reviewDelegation'
import type { AbsenceError } from '../services/reviewWorkload'
import type { RoutingRuleError } from '../services/reviewRouting'

/**
 * Коды и тексты ошибок делегирования, распределения и отсутствий (`docs/v2/37` §6, §10).
 * Коды стабильны — по ним экран выбирает перевод (`docs/04-api.md` §4.1); текст объясняет, что
 * делать (Definition of Done). Одна таблица на одиночное и массовое делегирование, чтобы
 * «Делегувати обрані» отвечал теми же кодами, что и кнопка в карточке.
 */
export const DELEGATE_ERRORS: Record<DelegateError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Роботу не знайдено'],
  forbidden: [403, 'forbidden', 'Передати можна лише роботу, за яку відповідаєте ви'],
  depth_exceeded: [422, 'review.delegate_depth_exceeded', 'Глибше передавати не можна: це вже друга передача'],
  already_in_review: [409, 'review.already_in_review', 'Цю роботу зараз перевіряє інша людина — передати її не можна'],
  due_too_soon: [422, 'validation_failed', 'Термін для делегата — не раніше ніж через 12 годин'],
  due_too_late: [422, 'validation_failed', 'Термін не може бути пізнішим за термін перевірки'],
  target_forbidden: [422, 'review.delegate_target_forbidden', 'Ця людина не має доступу до цієї точки'],
  target_declines: [422, 'review.delegate_target_declines', 'Ця людина зараз не приймає делеговані перевірки: відсутня або вимкнула делегування'],
  cycle: [422, 'review.delegate_cycle', 'Ця людина вже є в ланцюжку передач цієї роботи — оберіть іншу'],
}

export const REVOKE_ERRORS: Record<RevokeError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Делегування не знайдено'],
  forbidden: [403, 'forbidden', 'Відкликати може той, хто передав роботу, або керівник області'],
  closed: [409, 'review.delegation_closed', 'Делегування вже завершено — відкликати нічого'],
  in_progress: [409, 'review.delegation_in_progress', 'Делегат уже перевіряє цю роботу — відкликати не можна. Зверніться до керівника'],
  reason_required: [422, 'validation_failed', 'Вкажіть причину відкликання'],
}

export const REASSIGN_ERRORS: Record<ReassignError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Роботу не знайдено'],
  forbidden: [403, 'forbidden', 'Переназначити можна лише роботу своєї області'],
  target_forbidden: [422, 'review.delegate_target_forbidden', 'Ця людина не має доступу до цієї точки'],
  target_declines: [422, 'review.delegate_target_declines', 'Ця людина зараз відсутня — оберіть іншу'],
}

export const ABSENCE_ERRORS: Record<AbsenceError, [number, string, string]> = {
  range_invalid: [422, 'reviewer_absence.range_invalid', 'Дата завершення не може бути раніше початку, а звільнення — без дати завершення'],
  self_substitute: [422, 'absence.self_substitute', 'Не можна призначити заміщення самому собі'],
  forbidden: [403, 'forbidden', 'Відмічати можна лише свою відсутність або відсутність людей своєї області'],
  not_found: [404, 'not_found', 'Людину не знайдено'],
  substitute_invalid: [422, 'validation_failed', 'Заміщувач має бути активним співробітником'],
}

export const ROUTING_ERRORS: Record<RoutingRuleError, [number, string, string]> = {
  not_found: [404, 'not_found', 'Правило не знайдено'],
  forbidden: [403, 'forbidden', 'Правило стосується точок поза вашою областю'],
  scope_empty: [422, 'routing.scope_empty', 'Вкажіть точки, до яких застосовується правило: правило на всю мережу може створити лише адміністратор'],
  org_tree_missing: [422, 'validation_failed', 'Оргструктура ще не підключена — оберіть точки замість вузлів'],
  reviewers_invalid: [422, 'validation_failed', 'Перевіряючими можуть бути лише активні співробітники'],
  reviewers_required: [422, 'validation_failed', 'Для стратегії «Заданий список» оберіть перевіряючих'],
}
