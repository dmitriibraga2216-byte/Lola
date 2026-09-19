import { handleCallback } from '../../../../services/oauth'
import { providerParam } from './status.get'
/** Колбек провайдера: отдельное окно без cookie — тенант из state; окно закрывается само, панель перечитывает статус (docs/09 §9.2). */
export default defineEventHandler(async (event) => {
  const p = providerParam(event)
  const q = getQuery(event) as { code?: string, state?: string, error?: string }
  const r = p ? await handleCallback(p, q) : { ok: false as const, code: 'bad_state' as const, message: 'Невідомий провайдер' }
  const payload = r.ok ? { ok: true, provider: r.provider, account: r.accountLabel } : { ok: false, code: r.code, message: r.message }
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  const msg = r.ok ? `Підключено як ${r.accountLabel}. Це вікно закриється.` : r.message
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><title>Lola</title><body style="font-family:system-ui;padding:24px;text-align:center"><p>${msg.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</p><script>try{window.opener&&window.opener.postMessage(${JSON.stringify({ type: 'lola:oauth', ...payload })},'*')}catch(e){};setTimeout(function(){window.close()},${r.ok ? 800 : 4000})</script></body></html>`
})
