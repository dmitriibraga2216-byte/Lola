import { z } from 'zod'
import { requireScope } from '../../../../../services/access'
import { testSmtpConnection } from '../../../../../services/channels'
import type { Provider } from '../../../../../services/secrets'
import { apiData, apiError } from '../../../../../utils/apiResponse'
/** POST /settings/integrations/smtp/test (docs/09 §9.7.1 «Надіслати тестове повідомлення»). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.integrations')
  const provider = getRouterParam(event, 'provider') as Provider
  if (provider !== 'smtp') return apiError(event, 400, 'validation_failed', 'Перевірка зʼєднання доступна лише для e-mail')
  const p = z.object({ to: z.string().email() }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Вкажіть адресу')
  const res = await testSmtpConnection(a.tenantId, p.data.to)
  if (!res.ok) return apiError(event, 400, 'smtp_failed', res.error || 'Не вдалося надіслати тестовий лист')
  return apiData({ ok: true })
})
