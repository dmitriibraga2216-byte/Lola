import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/candidates'
import { candidateInterview } from '../../../../services/interview/recruiter'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * GET /candidates/:id/interview — вкладка «Співбесіда» (`docs/v2/30` §5.3, §10; `interview.view`):
 * сессии, оценки ИИ по критериям с обоснованием и цитатами, уверенность словом, техпаспорт,
 * расшифровка, флаги «Що варто перевірити людині», метрики и признак заглушки (Р-28.4).
 * Кандидат, невидимый зрителю, — `404`, не `403` (CLAUDE.md п. 15).
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'interview.view')
  const r = await candidateInterview(viewerOf(a), getRouterParam(event, 'id')!)
  return r ? apiData(r) : apiError(event, 404, 'not_found', 'Кандидата не знайдено')
})
