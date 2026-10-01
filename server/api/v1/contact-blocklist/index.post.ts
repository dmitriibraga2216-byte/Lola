import { blocklistCreateSchema } from '../../../../shared/schemas/vacancies'
import { requireScope } from '../../../services/access'
import { addToBlocklist } from '../../../services/contactBlocklist'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * POST /contact-blocklist — добавить телефон или почту (docs/v2/29 §7.7). Отклик с таким
 * контактом получает +100 к `spam_score` и молча уходит в «Спам».
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'candidate.edit')
  const p = blocklistCreateSchema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 422, 'validation', 'Вкажіть телефон або електронну пошту', { issues: p.error.issues })
  const r = await addToBlocklist({ tenantId: a.tenantId, actorId: a.userId }, p.data)
  if (r.ok) {
    setResponseStatus(event, 201)
    return apiData(r.items[0])
  }
  if (r.code === 'duplicate') return apiError(event, 409, 'blocklist.duplicate', 'Цей контакт уже в чорному списку')
  return apiError(event, 422, 'contact.invalid', 'Вкажіть телефон у форматі +380XXXXXXXXX або коректну електронну пошту')
})
