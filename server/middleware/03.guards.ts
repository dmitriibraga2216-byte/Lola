import type { AuthContext } from '../services/session'
import { isModuleEnabled, isRecruitingEnabled, isRecruitingRoute, moduleLock, moduleOfRoute } from '../services/modules'
import { forbiddenFor } from '../services/impersonation'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const PREVIEW_EXIT_PATH = '/api/v1/settings/roles/preview-as'

/**
 * Три сквозных запрета после аутентификации:
 * 1. Выключенный модуль (docs/24 §3.2, Г-24.2): его маршруты отвечают 403 `module.disabled`, данные остаются.
 * 2. Замок модуля по тарифу (docs/24 §3.2, §4.4; докс/33 D-053): 403 `module.plan_locked` с підписом
 *    «Доступно на тарифі …» — окремо від вимкненого модуля, аби текст пояснював саме причину.
 * 3. Режим «от имени» (docs/24 §4.5, docs/29 Б.13): роли, выгрузки, уведомления, GDPR-удаление, секреты
 *    интеграций — 403 `impersonation_forbidden`.
 * 4. «Переглянути систему як роль» (docs/24 §3.5, докс/33 D-052): у цьому режимі дозволено лише читання
 *    (GET/HEAD) і сама кнопка «Вихід» — решта 403 `preview_forbidden`.
 */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith('/api/v1/')) return
  const auth = event.context.auth as AuthContext | undefined
  if (!auth) return

  if (auth.previewRoleId) {
    const clean = event.path.split('?')[0]!
    const isExit = event.method === 'DELETE' && clean === PREVIEW_EXIT_PATH
    if (!SAFE_METHODS.has(event.method) && !isExit) {
      throw createError({ statusCode: 403, data: { code: 'preview_forbidden', message: 'У режимі перегляду «як роль» дії заборонені. Вийдіть з режиму і виконайте її від свого імені' } })
    }
  }

  if (auth.impersonatorAdminId) {
    const what = forbiddenFor(event.method, event.path)
    if (what) {
      throw createError({ statusCode: 403, data: { code: 'impersonation_forbidden', message: 'У режимі «від імені» ця дія заборонена. Вийдіть з режиму і виконайте її від свого імені', details: { what } } })
    }
  }

  // Рекрутинг выключен у тенанта (docs/v2/28, флаг `tenants.candidates_enabled`): маршруты
  // воронки отвечают так же, как выключенный модуль, — данные остаются, экран исчезает.
  // Ответ 403, а не 404: тенант не «чужой» (правило 15 про чужого), он просто ещё не включил
  // раздел, и текст должен вести туда, где его включают.
  if (isRecruitingRoute(event.path) && !(await isRecruitingEnabled(auth.tenantId))) {
    throw createError({ statusCode: 403, data: { code: 'candidates.disabled', message: 'Рекрутинг вимкнено в просторі. Увімкніть його в «Налаштування → Рекрутинг»' } })
  }

  const module = moduleOfRoute(event.path)
  if (module) {
    if (!(await isModuleEnabled(auth.tenantId, module))) {
      throw createError({ statusCode: 403, data: { code: 'module.disabled', message: 'Модуль вимкнено в налаштуваннях простору. Увімкніть його в «Налаштування → Модулі»', details: { module } } })
    }
    const lock = await moduleLock(auth.tenantId, module)
    if (lock) {
      throw createError({ statusCode: 403, data: { code: 'module.plan_locked', message: `Доступно на тарифі «${lock.planName}»`, details: { module, plan: lock.planCode } } })
    }
  }
})
