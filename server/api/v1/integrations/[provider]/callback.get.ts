import type { CallbackResult } from '../../../../services/oauth'
import { handleCallback } from '../../../../services/oauth'
import { completeSignin } from '../../../../services/session'
import { appOrigin, pickLocale, renderCallbackPage } from './_callback.render'
import { providerParam } from './status.get'

/**
 * Колбек провайдера: отдельное окно без cookie — тенант из state; окно закрывается само, панель перечитывает
 * статус (docs/09 §9.2). Фолбэк на случай, когда window.close() не срабатывает (Safari, вкладка вместо
 * попапа): ссылка возврата в налаштування інтеграцій лежит в разметке сразу (не появляется скриптом),
 * postMessage идёт на конкретный origin приложения — см. _callback.render.ts (там же тексты через i18n).
 *
 * Сюда же возвращается вход через Google: по умолчанию (`OAUTH_SIGNIN_CALLBACK=shared`) адрес возврата
 * для входа — этот, потому что он уже зарегистрирован в консоли провайдера. Поэтому колбек обязан
 * ветвиться по `purpose` из state: вход — сессия и обычный редирект, подключение — окно «Підключено».
 * Без этой ветки вход заканчивался успешной с виду страницей и без сессии.
 *
 * Локали для этой страницы: в проекте нет механизма определения языка для server-rendered HTML (ни cookie,
 * ни разбора Accept-Language где-либо ещё) — решаем это здесь минимально, через заголовок Accept-Language,
 * по умолчанию uk (как и defaultLocale в nuxt.config.ts).
 */
export default defineEventHandler(async (event) => {
  const p = providerParam(event)
  const q = getQuery(event) as { code?: string, state?: string, error?: string }
  const r: CallbackResult = p ? await handleCallback(p, q) : { ok: false, code: 'bad_state', message: 'Невідомий провайдер' }
  if (r.purpose === 'signin') {
    const done = await completeSignin(event, r)
    return sendRedirect(event, done.redirectTo)
  }
  const locale = pickLocale(getHeader(event, 'accept-language'))
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  return renderCallbackPage(r, locale, appOrigin())
})
