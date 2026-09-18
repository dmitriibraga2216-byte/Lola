import { z } from 'zod'

/** Телефон в E.164, украинский мобильный (docs/01-roles.md §1.5). */
export const phoneSchema = z.string()
  .transform(v => v.replace(/[\s\-()]/g, ''))
  .transform(v => (v.startsWith('0') ? `+38${v}` : v.startsWith('380') ? `+${v}` : v))
  .pipe(z.string().regex(/^\+380\d{9}$/, 'Невірний формат номера'))

export const otpRequestSchema = z.object({
  phone: phoneSchema,
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
