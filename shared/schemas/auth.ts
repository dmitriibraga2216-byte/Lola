import { z } from 'zod'

/** Телефон в E.164, украинский мобильный (docs/01-roles.md §1.5). */
export const phoneSchema = z.string()
  .transform(v => v.replace(/[\s\-()]/g, ''))
  .transform(v => (v.startsWith('0') ? `+38${v}` : v.startsWith('380') ? `+${v}` : v))
  .pipe(z.string().regex(/^\+380\d{9}$/, 'Невірний формат номера'))

/** `channel` — явний вибір людини («Надіслати код на пошту»), docs/01 §1.5. Без нього канал обирається автоматично. */
export const otpRequestSchema = z.object({
  phone: phoneSchema,
  channel: z.enum(['sms', 'email']).optional(),
})

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/, 'Код — шість цифр'),
})

export const tenantSelectSchema = z.object({
  selectToken: z.string().min(1),
  tenantId: z.string().uuid(),
})

export const inviteAcceptSchema = z.object({
  token: z.string().min(1),
})

/**
 * Путь этого же сайта для перехода после входа: `/…`, но не `//хост` и не `/\хост` — иначе ссылка
 * уводила бы на чужой сайт. Управляющие символы и обратная косая отвергаются по всей строке: браузер
 * выбрасывает из адреса табуляцию и перевод строки, и `/⇥/хост` превратился бы в тот же `//хост`.
 */
export function isLocalPath(v: string): boolean {
  if (!v.startsWith('/') || v[1] === '/') return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7F || c === 0x5C) return false // управляющие и «\»
  }
  return true
}
export const localPathSchema = z.string().max(2000).refine(isLocalPath)

/**
 * `GET /tg/go` — кнопка входа из бота (docs/23 §6 п. 7, docs/04 §4.19). Вход — только по
 * одноразовому токену `t`, выпущенному при отправке сообщения; `to` — куда вести после входа,
 * `n` — уведомление, под которым нажата кнопка (реакция для эскалации, docs/23 §6 п. 6).
 * Поля разбираются порознь: негодный `to` не лишает входа (ведём на главную), негодный токен
 * входа не даёт. Прочие параметры адреса не читаются.
 */
export const botLoginQuerySchema = z.object({
  t: z.string().regex(/^[\w-]{16,128}$/).optional().catch(undefined),
  to: localPathSchema.optional().catch(undefined),
  n: z.string().uuid().optional().catch(undefined),
})

export type OtpRequestInput = z.infer<typeof otpRequestSchema>
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>

/** Вход по e-mail + паролю (docs/01 §1.5, docs/04 §4.2) — если включено политикой тенанта. */
export const passwordLoginSchema = z.object({
  email: z.string().trim().email('Некоректна пошта').max(200),
  password: z.string().min(1, 'Введіть пароль').max(200),
})

/** POST /people/:id/password — пароль ставит администратор (docs/04 §4.11, скоуп people.password). */
export const passwordSetSchema = z.object({
  password: z.string().min(8).max(200),
  mustChange: z.boolean().optional(), // по умолчанию — политика «Змінити пароль після першого входу»
})

/** POST /me/password — собственный пароль; текущий обязателен, если пароль уже был. */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  password: z.string().min(8).max(200),
})
