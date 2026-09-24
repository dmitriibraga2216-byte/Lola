import { vacancyPublicationLinkExternalSchema } from '../../../../../../../shared/schemas/vacancies'
import { requireScope } from '../../../../../../services/access'
import { viewerOf } from '../../../../../../services/vacancies'
import { linkExternal } from '../../../../../../services/vacancyPublications'
import { apiData, apiError } from '../../../../../../utils/apiResponse'

/** POST /vacancies/:id/publications/:pid/link-external — «Прив'язати існуюче оголошення» (docs/v2/29 §7.17, §10). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'jobboard.publish')
  const p = vacancyPublicationLinkExternalSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation_failed', 'Вкажіть ідентифікатор оголошення', { issues: p.error.issues })
  const r = await linkExternal(viewerOf(a), getRouterParam(event, 'id')!, getRouterParam(event, 'pid')!, p.data)
  if (r.ok) return apiData({ ok: true })
  if (r.code === 'not_found') return apiError(event, 404, 'not_found', 'Публікацію не знайдено')
  return apiError(event, 409, 'publication.not_conflict', 'Прив\'язка можлива лише для публікації в конфлікті')
})
