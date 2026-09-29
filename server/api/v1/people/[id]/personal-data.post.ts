import { personalDataExportSchema } from '../../../../../shared/schemas/people'
import { requireScope } from '../../../../services/access'
import { exportPersonalData } from '../../../../services/personalDataExport'
import { apiError } from '../../../../utils/apiResponse'

/**
 * Выгрузка персональных данных по запросу субъекта (docs/v2/38 §7.4, §12) — пара к
 * `POST /people/gdpr-erase` и с тем же правом: `settings.tenant`. Основание обязательно, факт
 * выгрузки — в `audit_log`. Ответ — JSON-файл; кандидат и чужой тенант — `404`.
 */
export default defineEventHandler(async (event) => {
  const access = await requireScope(event, 'settings.tenant')
  const parsed = personalDataExportSchema.safeParse(await readBody(event))
  if (!parsed.success) return apiError(event, 400, 'validation_failed', 'Вкажіть підставу — запит людини', { issues: parsed.error.issues })
  const r = await exportPersonalData({ tenantId: access.tenantId, actorId: access.userId }, getRouterParam(event, 'id')!, parsed.data.reason)
  if (!r.ok) return apiError(event, 404, 'not_found', 'Людину не знайдено')
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="lola-personal-data-${r.data.subjectId}.json"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return JSON.stringify(r.data, null, 2)
})
