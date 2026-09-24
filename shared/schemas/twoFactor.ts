import { z } from 'zod'

/**
 * Контракты двухфакторного входа (docs/24 §3.4, docs/04 §4.2; PR-39). Код приложения —
 * шесть цифр; резервный код — десять знаков, дефис и пробелы не важны.
 */

export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Код — шість цифр')
export const recoveryCodeSchema = z.string().trim().min(10).max(20)

/** POST /auth/two-factor/verify — ровно один из двух: код приложения или резервный код. */
export const twoFactorVerifySchema = z.union([
  z.object({ code: totpCodeSchema }).strict(),
  z.object({ recoveryCode: recoveryCodeSchema }).strict(),
])
export type TwoFactorVerifyInput = z.infer<typeof twoFactorVerifySchema>

/** POST /auth/two-factor/setup — при уже подключённом факторе замена требует текущий код. */
export const twoFactorSetupSchema = z.object({ code: totpCodeSchema.optional() }).strict()

/** POST /auth/two-factor/confirm — первый код из приложения подтверждает новый секрет. */
export const twoFactorConfirmSchema = z.object({ code: totpCodeSchema }).strict()

/** DELETE /auth/two-factor и POST /auth/two-factor/recovery-codes — подтверждение текущим кодом. */
export const twoFactorProofSchema = twoFactorVerifySchema

/** POST /platform/tenants/:id/users/:userId/two-factor-reset — причина как у входа «от имени» (docs/24 §4.5). */
export const twoFactorPlatformResetSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict()
