import { describe, expect, it } from 'vitest'
import { KEYSETS, decodeKeyset, encodeKeyset } from '../../shared/domain/keyset'
import { candidateBoardSchema, candidateHireSchema, candidateRejectSchema, candidateReopenSchema } from '../../shared/schemas/candidates'
import { recruitingPatchSchema, tenantSettingsSchema } from '../../shared/schemas/settings'

/**
 * Правила воронки, проверяемые без БД (docs/v2/28-recruiting-candidates.md §5.2, §6.2, §7.5, §7.9).
 * Переходы состояний и транзакция найма живут в `tests/integration/v2-candidates-funnel.spec.ts`:
 * их смысл — в том, что делает база, а не в том, что считает функция.
 */

describe('курсор колонки канбана (§5.2, критерий §13 к. 12)', () => {
  it('кодируется парой «дата создания + id» и читается обратно без потерь — с микросекундами', () => {
    const row = { cursorAt: '2026-09-23T10:11:12.345678Z', id: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f' }
    const cursor = encodeKeyset(KEYSETS.candidateBoard, [row.cursorAt, row.id])
    expect(decodeKeyset(KEYSETS.candidateBoard, cursor)).toEqual([row.cursorAt, row.id])
  })

  // [исправлено 24.09.2026, keyset-курсор] Ранее: «пустой и битый курсор не ломают страницу —
  // просто первая страница». Первая страница вместо следующей даёт дубли на «Показати ще»;
  // битый курсор теперь режет схема входа (422 `validation_failed`), пустой — по-прежнему начало.
  it('пустой курсор — первая страница, битый и прежний `<ISO>|<id>` отсекаются схемой входа', () => {
    expect(candidateBoardSchema.safeParse({ cursor: '' }).success).toBe(true)
    expect(candidateBoardSchema.safeParse({ cursor: 'без-разделителя' }).success).toBe(false)
    expect(candidateBoardSchema.safeParse({ cursor: 'не-дата|3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f' }).success).toBe(false)
    expect(candidateBoardSchema.safeParse({ cursor: '2026-09-23T10:11:12.345Z|3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f' }).success).toBe(false)
  })

  it('страница колонки ограничена полусотней: доска не грузит колонку целиком', () => {
    expect(candidateBoardSchema.parse({}).limit).toBe(50)
    expect(candidateBoardSchema.parse({ limit: '25' }).limit).toBe(25)
    expect(() => candidateBoardSchema.parse({ limit: 250 })).toThrow()
  })
})

describe('контракты решений по кандидату (§5.5, §6.2, §4.2)', () => {
  it('найм требует точку, должность и дату выхода (§5.5)', () => {
    const ok = candidateHireSchema.parse({
      locationId: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f',
      positionId: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e70',
      startDate: '2026-10-01',
    })
    expect(ok.onboardingCourseIds).toEqual([])
    expect(ok.welcomeLetter).toBe(false)
    expect(() => candidateHireSchema.parse({ positionId: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e70', startDate: '2026-10-01' })).toThrow()
    expect(() => candidateHireSchema.parse({
      locationId: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e7f',
      positionId: '3f6c0b3e-0c4a-4b0e-9c1a-2a3b4c5d6e70',
      startDate: 'завтра',
    })).toThrow()
  })

  it('отказ без причины из закрытого перечня не принимается (§6.2, §9 п. 5)', () => {
    expect(candidateRejectSchema.parse({ reasonCode: 'skills' }).notify).toBe(false)
    expect(() => candidateRejectSchema.parse({})).toThrow()
    expect(() => candidateRejectSchema.parse({ reasonCode: 'не_сподобався' })).toThrow()
  })

  it('возврат в воронку требует объяснения: это решение администратора (§4.2)', () => {
    expect(candidateReopenSchema.parse({ reasonText: 'передумали' }).reasonText).toBe('передумали')
    expect(() => candidateReopenSchema.parse({})).toThrow()
    expect(() => candidateReopenSchema.parse({ reasonText: 'ок' })).toThrow()
  })
})

describe('настройки рекрутинга: сроки из документа, флаг — не ключ настроек (§7.5, §7.9)', () => {
  it('умолчания — 30 дней архивации и 6 месяцев согласия', () => {
    const s = tenantSettingsSchema.parse({}).recruiting
    expect(s.autoArchiveRejected).toBe(true)
    expect(s.archiveAfterDays).toBe(30)
    expect(s.consentMonths).toBe(6)
    expect(s.notifyRejected).toBe(false)
  })

  it('диапазоны — ровно те, что названы в документе: 7–365 дней и 1–24 месяца', () => {
    expect(recruitingPatchSchema.parse({ archiveAfterDays: 7 }).archiveAfterDays).toBe(7)
    expect(recruitingPatchSchema.parse({ archiveAfterDays: 365 }).archiveAfterDays).toBe(365)
    expect(() => recruitingPatchSchema.parse({ archiveAfterDays: 6 })).toThrow()
    expect(() => recruitingPatchSchema.parse({ archiveAfterDays: 366 })).toThrow()
    expect(recruitingPatchSchema.parse({ consentMonths: 1 }).consentMonths).toBe(1)
    expect(recruitingPatchSchema.parse({ consentMonths: 24 }).consentMonths).toBe(24)
    expect(() => recruitingPatchSchema.parse({ consentMonths: 25 })).toThrow()
  })

  it('`enabled` есть в патче, но не в группе настроек: у флага один носитель — колонка (В-14)', () => {
    expect(recruitingPatchSchema.parse({ enabled: true }).enabled).toBe(true)
    expect('enabled' in tenantSettingsSchema.parse({}).recruiting).toBe(false)
    expect(() => recruitingPatchSchema.parse({ candidatesEnabled: true })).toThrow()
  })
})
