import { candidateHireSchema } from '../../../../../shared/schemas/candidates'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { hireCandidate } from '../../../../services/candidateHire'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /candidates/:id/hire — найм (docs/v2/28 §5.5, §7.6, §10).
 *
 * Вся транзакция — в сервисе: здесь только валидация, скоуп и перевод исхода в ответ
 * (CLAUDE.md п. 6). `409 limit.users_exceeded` возвращает продлённое право входа кандидата:
 * человек не должен потеряться из-за исчерпанного тарифа (§12.5).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.hire')
  const p = candidateHireSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте точку, посаду і дату виходу', { issues: p.error.issues })
  const r = await hireCandidate(viewerOf(a), getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData(r.outcome)
  switch (r.code) {
    case 'not_found': return apiError(event, 404, 'not_found', 'Кандидата не знайдено')
    case 'not_active': return apiError(event, 409, 'candidate.not_active', 'Найняти можна лише активного кандидата')
    case 'location_not_found': return apiError(event, 404, 'not_found', 'Точку не знайдено')
    case 'position_not_found': return apiError(event, 404, 'not_found', 'Посаду не знайдено')
    case 'limit_exceeded': return apiError(event, 409, 'limit.users_exceeded', 'Ліміт співробітників за тарифом вичерпано. Доступ кандидата продовжено на 14 днів', { limit: r.limit, current: r.current, accessUntil: r.accessUntil })
  }
})
