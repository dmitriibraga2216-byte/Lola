import { describe, expect, it } from 'vitest'
import { addBillingPeriod } from '../../server/services/platformTenants'
import { tenantPaymentSchema } from '../../shared/schemas/billing'

/**
 * PR-10 пакета docs/v2 (docs/v2/35-billing-limits.md §7.8 п. 6): продление подписки считается
 * от прежней даты окончания, а не от даты платежа — `addBillingPeriod` единственное место,
 * где это арифметика (сравнение `server/services/platformTenants.ts` recordTenantPayment).
 */
describe('addBillingPeriod (docs/v2/35 §7.8 п. 6)', () => {
  it('месяц: обычная дата', () => {
    expect(addBillingPeriod('2026-03-10', 'month')).toBe('2026-04-10')
  })

  it('год: переносит год, число и месяц сохраняются', () => {
    expect(addBillingPeriod('2026-03-10', 'year')).toBe('2027-03-10')
  })

  it('месяц: перенос через границу года', () => {
    expect(addBillingPeriod('2026-12-15', 'month')).toBe('2027-01-15')
  })

  it('месяц: 31 января зажимается в границы февраля (не «перепрыгивает» в март)', () => {
    expect(addBillingPeriod('2026-01-31', 'month')).toBe('2026-02-28') // 2026 — не високосный
  })

  it('год: 29 февраля високосного года зажимается в невисокосном', () => {
    expect(addBillingPeriod('2024-02-29', 'year')).toBe('2025-02-28')
  })

  it('месяц: 30 апреля + месяц = 30 мая (обычный конец месяца, не 31)', () => {
    expect(addBillingPeriod('2026-04-30', 'month')).toBe('2026-05-30')
  })
})

describe('tenantPaymentSchema (docs/v2/35 §5.6, §10): комментарий 10–500 знаков обязателен', () => {
  const base = { kind: 'adjustment' as const, amountMinor: 1000, currency: 'eur' }

  it('короче 10 знаков — отклоняется', () => {
    expect(tenantPaymentSchema.safeParse({ ...base, comment: 'коротко' }).success).toBe(false)
  })

  it('10–500 знаков — принимается, валюта приводится к верхнему регистру', () => {
    const r = tenantPaymentSchema.safeParse({ ...base, comment: 'достатньо довгий коментар' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.currency).toBe('EUR')
  })

  it('status по умолчанию — paid: ручной приём подтверждает платёж сразу', () => {
    const r = tenantPaymentSchema.safeParse({ ...base, comment: 'достатньо довгий коментар' })
    expect(r.success && r.data.status).toBe('paid')
  })
})
