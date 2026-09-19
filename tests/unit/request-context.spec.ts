import { describe, expect, it } from 'vitest'
import { describeContext, parseUserAgent } from '../../server/utils/requestContext'

/** Браузер и ОС в журналах — как в эталоне: «Chrome 144, Windows», «Safari 26, iOS 18» (docs/22 §13.4). */
describe('request_context: разбор user-agent', () => {
  it('Chrome на Windows', () => {
    const r = parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36')
    expect(r).toEqual({ browser: 'Chrome 144', os: 'Windows', device: 'desktop' })
  })
  it('Safari на iPhone', () => {
    const r = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1')
    expect(r).toEqual({ browser: 'Safari 26', os: 'iOS 18', device: 'mobile' })
  })
  it('Chrome на Android-планшете и бот', () => {
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36').device).toBe('tablet')
    expect(parseUserAgent('curl/8.4.0')).toEqual({ browser: 'Bot', os: null, device: 'bot' })
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, device: null })
  })
  it('строки для интерфейса', () => {
    expect(describeContext({ ip: '1.2.3.4', geo: { country: 'Україна', countryCode: 'UA', city: 'Одеса' }, userAgent: 'x', browser: 'Chrome 144', os: 'Windows', device: 'desktop' }))
      .toEqual({ client: 'Chrome 144, Windows', place: 'Україна, Одеса' })
    expect(describeContext(null)).toEqual({ client: null, place: null })
  })
})
