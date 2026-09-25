import type { H3Event } from 'h3'
import type { ZodError } from 'zod'
import type { ProviderErrorCode } from '../services/ai/providers'
import type { AiUnavailableReason } from '../services/ai/policy'
import { apiError } from './apiResponse'

/**
 * Коды ответов ИИ (`docs/v2/30` §10, `docs/v2/41` §4.4; план `45` PR-27) — одна таблица на все
 * ручки, чтобы один и тот же отказ не получал два текста. Каждый текст объясняет, что делать
 * (DoD). Чужой тенант — `404` (CLAUDE.md п. 15): под RLS профиль не находится.
 */
const PROVIDER_ERRORS: Record<ProviderErrorCode, readonly [number, string, string]> = {
  not_found: [404, 'not_found', 'Профіль провайдера не знайдено'],
  code_taken: [409, 'provider.code_taken', 'Профіль із таким кодом уже є — змініть код'],
  retention_unknown: [422, 'provider.retention_unknown', 'Провайдер із невідомим строком зберігання не допускається для розшифровки. Вкажіть, скільки провайдер зберігає дані, або оберіть інший профіль'],
  endpoint_required: [422, 'provider.endpoint_required', 'Вкажіть адресу API провайдера: без неї працює лише заглушка'],
  endpoint_invalid: [422, 'provider.endpoint_invalid', 'Адреса API має починатися з https:// і вести до провайдера в інтернеті, а не у внутрішню мережу'],
  region_comment_required: [422, 'provider.region_comment_required', 'Поясніть, чому дані оброблятимуться поза ЄС: коментар потрапить у журнал дій'],
  fallback_self: [422, 'provider.fallback_self', 'Запасний профіль не може посилатися сам на себе'],
  fallback_not_found: [422, 'provider.fallback_not_found', 'Запасний профіль не знайдено — оберіть інший'],
  fallback_purpose: [422, 'provider.fallback_purpose', 'Запасний профіль має виконувати ту саму роль, що й основний'],
  fallback_cycle: [422, 'provider.fallback_cycle', 'Запасні профілі посилаються один на одного по колу — приберіть одне з посилань'],
  fallback_depth: [422, 'provider.fallback_depth', 'Ланцюжок запасних профілів — не довший за два переходи'],
}

export function providerFail(event: H3Event, code: ProviderErrorCode) {
  const [status, apiCode, text] = PROVIDER_ERRORS[code]
  return apiError(event, status, apiCode, text)
}

export function providerValidationFail(event: H3Event, error: ZodError) {
  return apiError(event, 422, 'validation_failed', error.issues[0]?.message ?? 'Перевірте поля профілю', { issues: error.issues })
}

const UNAVAILABLE_TEXT: Record<AiUnavailableReason, string> = {
  expired: 'Підписку на ШІ завершено. Продовжте її в «Налаштування → Тариф», щоб знову користуватися ШІ',
  off: 'ШІ вимкнено для вашого простору. Зверніться до підтримки Lola',
  readonly: 'Простір у режимі лише читання: функції ШІ вимкнені до продовження тарифу',
  suspended: 'Простір призупинено, функції ШІ недоступні',
}

/**
 * ИИ-подписка не действует (`35` §7.7 п. 4, §7.8 п. 4): `409 ai.unavailable`, причина — в
 * `details.reason`, а не в коде (`44` В-16: один код, один диалог на фронте).
 */
export function aiUnavailableFail(event: H3Event, reason: AiUnavailableReason) {
  return apiError(event, 409, 'ai.unavailable', UNAVAILABLE_TEXT[reason], { reason })
}

/** Провайдер не ответил ни основным профилем, ни запасными (`30` §7.12): `503`, повтор имеет смысл. */
export function aiProviderFail(event: H3Event, reason: string) {
  const text = reason === 'no_provider'
    ? 'Для цієї функції не налаштовано жодного профілю ШІ. Увімкніть профіль у налаштуваннях ШІ'
    : 'Провайдер ШІ зараз не відповідає. Спробуйте ще раз за хвилину'
  return apiError(event, 503, 'ai.provider_failed', text, { reason })
}
