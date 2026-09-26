import { requirePlatform } from '../../../../../utils/platformGuard'
import { getSmtpIgnoreTlsErrors } from '../../../../../services/platformTenants'
import { apiData } from '../../../../../utils/apiResponse'

/** GET /platform/tenants/:id/smtp-tls — «Ігнорувати помилки TLS» (docs/09 §9.7.1 п. 3, докс/33 D-050): лише оператор платформи. */
export default defineEventHandler(async (event) => {
  requirePlatform(event, 'tenant.read')
  return apiData({ ignoreTlsErrors: await getSmtpIgnoreTlsErrors(getRouterParam(event, 'id')!) })
})
