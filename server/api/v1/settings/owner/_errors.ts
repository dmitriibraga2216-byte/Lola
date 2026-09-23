import type { H3Event } from 'h3'
import type { OwnerError } from '../../../../services/owner'
import { apiError } from '../../../../utils/apiResponse'

/** Коди помилок володіння з поясненням, що робити (docs/01 §1.9.4). */
export function ownerError(event: H3Event, code: OwnerError) {
  switch (code) {
    // Чужа людина не відрізняється від неіснуючої (CLAUDE.md п. 15): 404 без подробиць
    case 'not_found': return apiError(event, 404, 'not_found', 'Людину не знайдено')
    case 'already_owned': return apiError(event, 409, 'already_owned', 'У простору вже є власник — володіння передає він')
    case 'no_owner': return apiError(event, 409, 'no_owner', 'У простору ще немає власника — спершу хтось має стати ним')
    case 'not_owner': return apiError(event, 403, 'not_owner', 'Передати володіння може лише чинний власник')
    case 'same_person': return apiError(event, 409, 'same_person', 'Ви вже власник цього простору')
    case 'not_eligible': return apiError(event, 409, 'not_eligible', 'Власником може бути лише діючий співробітник — не кандидат і не заблокований')
  }
}
