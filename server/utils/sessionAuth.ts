import type { H3Event } from 'h3'
import type { AuthContext } from '../services/session'

/**
 * Сессия человека для ручек второго фактора (docs/24 §3.4, PR-39). Не `requireScope`: права
 * здесь не при чём — фактор принадлежит самому человеку, а промежуточная сессия прав не имеет
 * вовсе. Bearer-токен второго фактора не имеет и в эти ручки не входит (это не список путей
 * В-20, а отсутствие сессии: у токена нет ни человека за экраном, ни его телефона).
 *
 * `allowPending` — ручка работает и в промежуточной сессии (проверка кода, подключение на
 * экране входа); без него промежуточная получает `401 two_factor_required`.
 */
export function sessionAuth(event: H3Event, opts: { allowPending?: boolean } = {}): AuthContext {
  const auth = event.context.auth as AuthContext | undefined
  if (!auth || event.context.tokenScopes) {
    throw createError({ statusCode: 401, data: { code: 'auth_required', message: 'Потрібен вхід' } })
  }
  if (auth.twoFactorPending && !opts.allowPending) {
    throw createError({ statusCode: 401, data: { code: 'two_factor_required', message: 'Підтвердіть вхід кодом із застосунку-автентифікатора' } })
  }
  return auth
}

/** Отказы ручек второго фактора — единые коды и тексты (docs/04 §4.2): текст говорит, что делать. */
const TWO_FACTOR_ERRORS: Record<string, { status: number, message: string }> = {
  invalid: { status: 401, message: 'Код невірний. Перевірте час на телефоні й введіть новий код із застосунку' },
  blocked: { status: 429, message: 'Забагато невірних кодів. Вхід тимчасово заблоковано — спробуйте пізніше або зверніться до адміністратора' },
  not_pending: { status: 409, message: 'Вхід уже підтверджено або сесія застаріла. Увійдіть ще раз' },
  not_enrolled: { status: 409, message: 'Двофакторний вхід не підключено' },
  verify_first: { status: 409, message: 'Спершу підтвердіть вхід кодом із застосунку' },
  code_required: { status: 422, message: 'Щоб замінити пристрій, введіть поточний код із застосунку' },
  no_pending: { status: 409, message: 'Спершу натисніть «Підключити застосунок» і відскануйте QR-код' },
  setup_expired: { status: 409, message: 'Ключ застарів. Натисніть «Підключити застосунок» ще раз і відскануйте новий QR-код' },
  required_by_policy: { status: 409, message: 'У просторі адміністратори входять лише з двофакторним входом. Щоб змінити телефон, підключіть новий застосунок замість вимкнення' },
  self: { status: 409, message: 'Свій другий фактор вимикають власним кодом — у блоці «Мій вхід»' },
  not_found: { status: 404, message: 'Людину не знайдено' },
}

export function twoFactorError(event: H3Event, code: string, attemptsLeft?: number) {
  const e = TWO_FACTOR_ERRORS[code] ?? { status: 400, message: 'Не вдалося' }
  setResponseStatus(event, e.status)
  const details = attemptsLeft !== undefined ? { attemptsLeft } : undefined
  return { error: { code: code === 'invalid' ? 'two_factor_invalid' : code === 'blocked' ? 'rate_limited' : `two_factor.${code}`, message: e.message, ...(details ? { details } : {}) } }
}
