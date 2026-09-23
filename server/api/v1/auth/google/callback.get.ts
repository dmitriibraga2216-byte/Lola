import { handleCallback } from '../../../../services/oauth'
import { completeSignin } from '../../../../services/session'

/**
 * Колбек входа через Google: e-mail из профиля → активный пользователь тенанта из state → сессия.
 * Трафик сюда идёт только при `OAUTH_SIGNIN_CALLBACK=split`, то есть когда этот адрес зарегистрирован
 * в Google Cloud Console; по умолчанию вход возвращается на путь интеграций, и там тот же `completeSignin`.
 */
export default defineEventHandler(async (event) => {
  const r = await handleCallback('google', getQuery(event) as { code?: string, state?: string, error?: string })
  const done = await completeSignin(event, r)
  return sendRedirect(event, done.redirectTo)
})
