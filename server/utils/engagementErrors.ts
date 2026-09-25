import type { H3Event } from 'h3'
import type { EngagementResult } from '../services/engagementIndex'
import { apiError } from './apiResponse'

type EngagementError = Extract<EngagementResult, { ok: false }>['code']

/**
 * Коды ошибок індексу залученості (docs/v2/38 §10, docs/v2/41 §4.12) — одна таблица на ручки.
 * «Нет скоупа» — одно написание `forbidden` (`44` В-16 §8.2.7), а не `rating_forbidden`.
 */
export function engagementError(event: H3Event, code: EngagementError) {
  switch (code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Людину не знайдено')
    case 'forbidden': return apiError(event, 403, 'forbidden', 'Немає доступу до індексу залученості цієї людини')
    case 'person_archived': return apiError(event, 409, 'person_archived', 'Співробітника звільнено — його індекс зафіксовано й не перераховується')
    case 'recalc_too_often': return apiError(event, 429, 'recalc_too_often', 'Перерахунок можливий раз на годину — спробуйте пізніше')
  }
}
