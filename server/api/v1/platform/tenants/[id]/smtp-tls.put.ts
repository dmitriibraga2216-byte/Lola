import { z } from 'zod'
import { requirePlatform } from '../../../../../utils/platformGuard'
import { setSmtpIgnoreTlsErrors } from '../../../../../services/platformTenants'
import { apiData, apiError } from '../../../../../utils/apiResponse'

/**
 * PUT /platform/tenants/:id/smtp-tls — «Ігнорувати помилки TLS» (docs/09 §9.7.1 п. 3, докс/33
 * D-050): небезпечний прапорець, тому доступний лише оператору платформи, а не тенанту, і кожна
 * зміна пишеться в `platform_audit`.
 */
export default defineEventHandler(async (event) => {
  const actor = requirePlatform(event, 'tenant.update')
  const p = z.object({ ignoreTlsErrors: z.boolean() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Очікується ignoreTlsErrors: boolean')
  await setSmtpIgnoreTlsErrors(getRouterParam(event, 'id')!, p.data.ignoreTlsErrors, actor)
  return apiData({ ok: true })
})
