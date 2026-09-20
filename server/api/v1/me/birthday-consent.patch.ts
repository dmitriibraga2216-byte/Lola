import { birthdayConsentSchema } from '../../../../shared/schemas/hub'
import { requireScope } from '../../../services/access'
import { setBirthdayConsent } from '../../../services/hubPeople'
import { apiData, apiError } from '../../../utils/apiResponse'

/** PATCH /me/birthday-consent — согласие показывать день рождения (29 Б.16, opt-out). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'learn.view')
  const p = birthdayConsentSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте значення')
  return apiData(await setBirthdayConsent({ tenantId: a.tenantId, actorId: a.userId }, p.data.birthdayConsent))
})
