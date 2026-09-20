import type { AuthContext } from '../services/session'
import { isModuleEnabled, moduleOfRoute } from '../services/modules'
import { forbiddenFor } from '../services/impersonation'

/**
 * Два сквозных запрета после аутентификации:
 * 1. Выключенный модуль (docs/24 §3.2, Г-24.2): его маршруты отвечают 403 `module.disabled`, данные остаются.
 * 2. Режим «от имени» (docs/24 §4.5, docs/29 Б.13): роли, выгрузки, уведомления, GDPR-удаление, секреты
 *    интеграций — 403 `impersonation_forbidden`.
 */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/v1/')) return
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return

  if (auth.impersonatorAdminId) {
    const what = forbiddenFor(event.method, event.path)
    if (what) {
      throw createError({ statusCode: 403, data: { code: 'impersonation_forbidden', message: 'У режимі «від імені» ця дія заборонена. Вийдіть з режиму і виконайте її від свого імені', details: { what } } })
    }
  }

  const module = moduleOfRoute(event.path)
  if (module && !(await isModuleEnabled(auth.tenantId, module))) {
    throw createError({ statusCode: 403, data: { code: 'module.disabled', message: 'Модуль вимкнено в налаштуваннях простору. Увімкніть його в «Налаштування → Модулі»', details: { module } } })
  }
})
