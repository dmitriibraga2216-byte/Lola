import type { CallbackResult } from '../../../../services/oauth'
import { handleCallback } from '../../../../services/oauth'
import { appOrigin, pickLocale, renderCallbackPage } from './_callback.render'
import { providerParam } from './status.get'

/**
 * Колбек провайдера: отдельное окно без cookie — тенант из state; окно закрывается само, панель перечитывает
 * статус (docs/09 §9.2). Фолбэк на случай, когда window.close() не срабатывает (Safari, вкладка вместо
 * попапа): ссылка возврата в налаштування інтеграцій лежит в разметке сразу (не появляется скриптом),
 * postMessage идёт на конкретный origin приложения — см. _callback.render.ts (там же тексты через i18n).
 *
 * Локали для этой страницы: в проекте нет механизма определения языка для server-rendered HTML (ни cookie,
 * ни разбора Accept-Language где-либо ещё) — решаем это здесь минимально, через заголовок Accept-Language,
 * по умолчанию uk (как и defaultLocale в nuxt.config.ts).
 */
export default defineEventHandler(async (event) => {
  const p = providerParam(event)
  const q = getQuery(event) as { code?: string, state?: string, error?: string }
  const r: CallbackResult = p ? await handleCallback(p, q) : { ok: false, code: 'bad_state', message: 'Невідомий провайдер' }
  const locale = pickLocale(getHeader(event, 'accept-language'))
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  return renderCallbackPage(r, locale, appOrigin())
})
