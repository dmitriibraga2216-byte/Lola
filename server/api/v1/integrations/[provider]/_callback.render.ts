import type { CallbackResult } from '../../../../services/oauth'
import type { Locale } from '../../../../services/translations'
import { defaultDictionary } from '../../../../services/translations'

/**
 * Рендер страницы-колбека OAuth — вынесено из callback.get.ts в отдельный файл без h3-автоимпортов
 * (defineEventHandler и т.п.), чтобы юнит-/интеграционный тест мог импортировать эти функции напрямую,
 * не поднимая Nitro. Сам маршрут (callback.get.ts) остаётся тонким: достаёт query/заголовки из event
 * и зовёт renderCallbackPage (CLAUDE.md п. 6).
 */

const BACK_HREF = '/admin/settings/integrations'

export function pickLocale(acceptLanguage?: string | null): Locale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const lang = part.trim().split(';')[0]?.toLowerCase()
    if (!lang) continue
    if (lang.startsWith('en')) return 'en'
    if (lang.startsWith('uk')) return 'uk'
    if (lang.startsWith('ru')) return 'ru'
  }
  return 'uk'
}

/** Origin приложения — та же переменная и та же нормализация, что и redirectUri() в services/oauth.ts. */
export function appOrigin(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

const esc = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&#39;' })[c]!)

// JSON внутри <script>: HTML-парсер ищет "</script" по всему документу, включая содержимое строк —
// account/message пользовательские (провайдер), поэтому "<" эскейпится в < (валидно для JS, не меняет значение)
const toScriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')

export function renderCallbackPage(r: CallbackResult, locale: Locale, origin: string): string {
  const dict = defaultDictionary(locale)
  const t = (key: string) => dict[key] ?? key
  const message = r.ok ? t('integrations.oauthCallback.connected').replace('{account}', esc(r.accountLabel)) : esc(r.message)
  const closingHint = esc(t('integrations.oauthCallback.closingHint'))
  const backLink = esc(t('integrations.oauthCallback.backLink'))
  const payload = r.ok
    ? { type: 'lola:oauth', ok: true, provider: r.provider, account: r.accountLabel }
    : { type: 'lola:oauth', ok: false, code: r.code, message: r.message }
  const delay = r.ok ? 800 : 4000

  return `<!doctype html><html lang="${locale}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Lola</title>
<style>
:root{--color-bg:#f0e7d7;--color-bg-soft:#faf6ec;--color-bg-line:#d8cdb8;--color-ink:#0c0f14;--color-ink-muted:#6b6154;--color-teal:#2bbfae;--color-teal-ink:#0d6f66;--color-coral-ink:#b23c22;--color-sun:#ffc933;--color-sun-ink:#7d5600;--font-family:'Nunito','Trebuchet MS',sans-serif;--radius-s:16px;--radius-2xl:36px;--radius-pill:999px}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--color-bg);color:var(--color-ink);font-family:var(--font-family);padding:16px}
.card{background:var(--color-bg-soft);border:1px solid var(--color-bg-line);border-radius:var(--radius-2xl);padding:24px;max-width:340px;width:100%;display:grid;gap:16px;text-align:center}
.brand{font-weight:900;font-size:1.5rem;margin:0}
.msg{margin:0;font-weight:700}
.msg.ok{color:var(--color-teal-ink)}
.msg.err{color:var(--color-coral-ink)}
.hint{margin:0;color:var(--color-ink-muted);font-size:.9rem}
.btn{display:inline-block;padding:12px 24px;border-radius:var(--radius-pill);background:var(--color-sun);color:var(--color-sun-ink);font-weight:800;text-decoration:none}
.btn:focus-visible{outline:3px solid var(--color-teal);outline-offset:2px;border-radius:var(--radius-s)}
</style>
</head><body>
<div class="card" id="fallback">
<p class="brand">Lola</p>
<p class="msg ${r.ok ? 'ok' : 'err'}">${message}</p>
<p class="hint">${closingHint}</p>
<a class="btn" href="${BACK_HREF}">${backLink}</a>
</div>
<script>
(function(){
  var el = document.getElementById('fallback')
  try { window.opener && window.opener.postMessage(${toScriptJson(payload)}, ${toScriptJson(origin)}) } catch (e) {}
  setTimeout(function () {
    if (el) el.style.display = 'none'
    try { window.close() } catch (e) {}
    // window.close() молчком не срабатывает вне попапа, открытого скриптом (особенно в Safari) —
    // если мы всё ещё тут спустя короткую паузу, значит закрыть не дали, возвращаем экран с ссылкой
    setTimeout(function () { if (el) el.style.display = '' }, 250)
  }, ${delay})
})()
</script>
</body></html>`
}
