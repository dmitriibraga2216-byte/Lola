/**
 * Доставка OTP. Этап 1 (docs/07-stages.md): Telegram + SMS-заглушка в логе.
 * Реальные провайдеры подключаются в этапе 4 (Telegram-бот) без смены интерфейса.
 */
export type OtpChannel = 'telegram' | 'sms'

export async function deliverOtp(channel: OtpChannel, phone: string, code: string): Promise<void> {
  // Заглушка: код в лог. Допустимо только пока SMS_PROVIDER=none (docs/26 §26.6).
  console.log(`[otp:${channel}] ${phone} → код ${code}`)
}
