import type { H3Event } from 'h3'
import type { AnnouncementError } from '../../../../services/platformAnnouncements'
import { apiError } from '../../../../utils/apiResponse'

/** Отказы ручек объявлений платформы (docs/04 §4.17): текст говорит оператору, что делать. */
export function announcementError(event: H3Event, code: AnnouncementError) {
  if (code === 'not_found') return apiError(event, 404, 'not_found', 'Оголошення не знайдено')
  if (code === 'archived') return apiError(event, 409, 'announcement.archived', 'Оголошення знято зі стрічки — створіть нове')
  return apiError(event, 422, 'announcement.unknown_plan', 'Такого тарифу немає — оберіть тариф зі списку')
}
