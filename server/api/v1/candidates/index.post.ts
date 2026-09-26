import { candidateCreateSchema } from '../../../../shared/schemas/candidates'
import { requireScope } from '../../../services/access'
import { createCandidate } from '../../../services/candidates'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /candidates — создание кандидата (docs/v2/28 §6.1, §7.1, §7.2, §10).
 *
 * Коды ошибок — из §10 и решения docs/v2/44 §5 (единый `limit_exceeded` с осью в деталях,
 * а не отдельный именованный код на каждую ось):
 * `400 candidate.contact_required` — ни телефона, ни почты;
 * `409 candidate.is_employee` — человек уже работает в компании (§12.1);
 * `409 candidate.duplicate` — найден тот же человек, форма показывает его карточку (§7.2);
 * `409 candidate.contact_taken` — контакт занят: повторный отклик ведётся в существующей
 *   карточке событием истории (§12.10), а не вторым профилем;
 * `409 limit_exceeded` (`axis=candidates_active`) — мест по тарифу нет (§7.1, критерий §13 к. 1);
 *   проверка — в транзакции создания под блокировкой оси (fix-candidate-limit-race);
 * `503 limit.check_failed` — лимит проверить не удалось, кандидат не создан (fail-closed).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = candidateCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Перевірте дані кандидата', { issues: p.error.issues })

  const r = await createCandidate({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) return apiData(r.candidate)
  switch (r.code) {
    case 'contact_required':
      return apiError(event, 400, 'candidate.contact_required', 'Вкажіть телефон або пошту')
    case 'is_employee':
      return apiError(event, 409, 'candidate.is_employee', 'Ця людина вже працює у компанії', { duplicates: r.duplicates })
    case 'duplicate':
      return apiError(event, 409, 'candidate.duplicate', 'Такий кандидат уже є', { duplicates: r.duplicates })
    case 'contact_taken':
      return apiError(event, 409, 'candidate.contact_taken', 'Такий номер або пошта вже є у кандидата чи співробітника', { duplicates: r.duplicates })
    case 'limit_exceeded':
      // Текст — из словаря (`limitMessage`, `billing.limitConsequence.candidates_active`); `used` —
      // как у единого отказа `LimitExceededError`, `current` — прежнее имя поля для клиента
      return apiError(event, 409, 'limit_exceeded', r.message, { axis: 'candidates_active', used: r.current, limit: r.limit, current: r.current })
    case 'status_not_found':
      return apiError(event, 422, 'validation_failed', 'Колонку воронки не знайдено')
  }
})
