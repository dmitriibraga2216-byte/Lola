import { afterEach, describe, expect, it } from 'vitest'

/**
 * Страница-колбек OAuth (server/api/v1/integrations/[provider]/callback.get.ts): window.close()
 * молчком не срабатывает вне попапа, открытого скриптом (особенно в Safari) — на это есть отдельная
 * приёмка: разметка всегда несёт ссылку возврата (работает и без JS), postMessage идёт на конкретный
 * origin (не '*'), подставляемые данные экранированы. Сама логика OAuth (state, обмен кода) покрыта
 * oauth.spec.ts — здесь только рендер страницы.
 */
const cb = await import('../../server/api/v1/integrations/[provider]/_callback.render')

const okResult = (accountLabel: string) => ({ ok: true as const, tenantId: 't1', provider: 'google' as const, accountLabel, purpose: 'connect' as const, createdBy: null })
const errResult = (message: string) => ({ ok: false as const, code: 'provider_error' as const, message })

afterEach(() => { delete process.env.APP_URL })

describe('колбек OAuth: экран вместо пустой вкладки', () => {
  it('ссылка возврата в налаштування завжди в розмітці (працює і без JS)', () => {
    const html = cb.renderCallbackPage(okResult('owner@kappi.ua'), 'uk', 'https://lola.kappi.ua')
    expect(html).toContain('href="/admin/settings/integrations"')
    expect(html).toContain('<a class="btn"')
    // ссылка — в самой разметке, а не собирается скриптом
    expect(html.indexOf('href="/admin/settings/integrations"')).toBeLessThan(html.indexOf('<script>'))
  })

  it('postMessage идёт на конкретный origin, не на "*"', () => {
    const html = cb.renderCallbackPage(okResult('owner@kappi.ua'), 'uk', 'https://lola.kappi.ua')
    expect(html).toContain('postMessage(')
    expect(html).toContain('"https://lola.kappi.ua"')
    expect(html).not.toMatch(/postMessage\([^)]*,\s*'\*'\)/)
    expect(html).not.toMatch(/postMessage\([^)]*,\s*"\*"\)/)
  })

  it('appOrigin() берёт APP_URL так же, как redirectUri() в services/oauth.ts, без слэша на конце', () => {
    process.env.APP_URL = 'https://lms.example.com/'
    expect(cb.appOrigin()).toBe('https://lms.example.com')
    delete process.env.APP_URL
    expect(cb.appOrigin()).toBe('http://localhost:3000')
  })

  it('email и текст ошибки экранированы в HTML (XSS через accountLabel/message)', () => {
    const evil = '<script>alert(1)</script>&"\''
    const okHtml = cb.renderCallbackPage(okResult(evil), 'uk', 'https://lola.kappi.ua')
    expect(okHtml).not.toContain('<script>alert(1)</script>')
    expect(okHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')

    const errHtml = cb.renderCallbackPage(errResult(evil), 'uk', 'https://lola.kappi.ua')
    expect(errHtml).not.toContain('<script>alert(1)</script>')
    expect(errHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // в HTML-разметке — амперсанд-экранирование; но данные летят ещё раз внутрь <script> (JSON для
    // postMessage), и там свой риск: буквальная подстрока "</script>" в значении разорвала бы тег —
    // её не должно быть, встречаться может только "\u003c/script"
    expect(okHtml.split('<script>').length).toBe(2) // только один настоящий <script> — наш собственный
    expect(errHtml.split('<script>').length).toBe(2)
    expect(okHtml.split('</script>').length).toBe(2) // ровно один настоящий закрывающий тег — наш
    expect(okHtml).toContain('\\u003cscript>alert(1)\\u003c/script>')
  })

  it('успех и ошибка — разные тексты и оформление, ссылка есть в обоих случаях', () => {
    const ok = cb.renderCallbackPage(okResult('owner@kappi.ua'), 'uk', 'https://lola.kappi.ua')
    expect(ok).toContain('owner@kappi.ua')
    expect(ok).toContain('class="msg ok"')
    expect(ok).toContain('href="/admin/settings/integrations"')

    const err = cb.renderCallbackPage(errResult('Провайдер відхилив код'), 'uk', 'https://lola.kappi.ua')
    expect(err).toContain('Провайдер відхилив код')
    expect(err).toContain('class="msg err"')
    expect(err).toContain('href="/admin/settings/integrations"')
  })

  it('локализация: en-заголовок отдаёт английские тексты вокруг сообщения', () => {
    const uk = cb.renderCallbackPage(okResult('owner@kappi.ua'), 'uk', 'https://lola.kappi.ua')
    const en = cb.renderCallbackPage(okResult('owner@kappi.ua'), 'en', 'https://lola.kappi.ua')
    expect(uk).toContain('Повернутися до налаштувань інтеграцій')
    expect(en).toContain('Back to integration settings')
    expect(en).toContain('Connected as owner@kappi.ua')
  })

  it('pickLocale: Accept-Language → uk/en, по умолчанию uk (defaultLocale проекта)', () => {
    expect(cb.pickLocale('en-US,en;q=0.9,uk;q=0.8')).toBe('en')
    expect(cb.pickLocale('uk-UA,en;q=0.5')).toBe('uk')
    expect(cb.pickLocale('fr-FR')).toBe('uk')
    expect(cb.pickLocale(undefined)).toBe('uk')
    expect(cb.pickLocale('')).toBe('uk')
  })
})
