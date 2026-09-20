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
