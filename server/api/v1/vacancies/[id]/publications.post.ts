import { vacancyPublicationCreateSchema } from '../../../../../shared/schemas/vacancies'
import { OWNER_ROLE_CODE } from '../../../../../shared/domain/roles'
import { requireScope } from '../../../../services/access'
import { viewerOf } from '../../../../services/vacancies'
import { createPublications } from '../../../../services/vacancyPublications'
import { apiData, apiError } from '../../../../utils/apiResponse'

/**
 * POST /vacancies/:id/publications — публикация на площадке или запись ручной публикации
 * (docs/v2/29 §7.13, §10, план `45` PR-17; `manual` — обходной путь `44` §8).
 *
 * `confirm: true` обязателен — подтверждающее действие (§7.13), а не побочный эффект вызова.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.publish')
  const p = vacancyPublicationCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'publication.confirm_required', 'Підтвердіть публікацію', { issues: p.error.issues })
  const isAdmin = a.roles.some(r => r.code === 'admin' || r.code === OWNER_ROLE_CODE)
  const r = await createPublications(viewerOf(a), { isAdmin }, getRouterParam(event, 'id')!, p.data)
  if (r.ok) return apiData({ items: r.publications })
  switch (r.code) {
    case 'not_found':
      return apiError(event, 404, 'not_found', 'Вакансію не знайдено')
    case 'account_not_found':
      return apiError(event, 404, 'not_found', 'Акаунт майданчика не знайдено')
    case 'account_forbidden':
      return apiError(event, 403, 'forbidden', 'Немає доступу до цього акаунта')
    case 'account_not_active':
      return apiError(event, 422, 'jobboard.account_not_active', 'Акаунт майданчика не підключено')
    case 'duplicate':
      return apiError(event, 409, 'publication.duplicate', 'Вакансія вже публікується на цьому майданчику', { accountId: r.accountId })
    default:
      return apiError(event, 422, 'validation_failed', 'Не вдалося опублікувати вакансію')
  }
})
