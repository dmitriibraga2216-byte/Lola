import { describe, expect, it } from 'vitest'
import {
  addMonths, daysBetween, documentFileAllowed, documentReminderDue, documentRequiredFor, documentRetentionUntil,
  documentStatusBy, documentTypeIsSingular, isVisibilityNarrowing, maskDocumentNumber, newerDocumentWins,
  noteArchiveAfter, noteRetentionMonths, normalizeNoteBody, validateDocumentDates,
} from '../../shared/domain/personRecords'
import { documentCreateSchema, documentTypeCreateSchema, noteCreateSchema, noteUpdateSchema } from '../../shared/schemas/personRecords'
import { screenNoteText } from '../../server/services/noteScreen'

/**
 * Правила заметок и документов человека (docs/v2/38-people-extensions.md §4, §6, §7.4–§7.8).
 * Здесь — то, где ошибка не видна глазом: срок хранения, однонаправленность видимости,
 * окно «истекает» и дни напоминаний, маска номера, словарь скрина.
 */

describe('§7.6 срок хранения заметки', () => {
  it('24 месяца обычным, 36 — training_plan, agreement и любой закреплённой', () => {
    expect(noteRetentionMonths('performance', false)).toBe(24)
    expect(noteRetentionMonths('incident', false)).toBe(24)
    expect(noteRetentionMonths('agreement', false)).toBe(36)
    expect(noteRetentionMonths('training_plan', false)).toBe(36)
    expect(noteRetentionMonths('general', true)).toBe(36)
  })

  it('дата архивации — created_at + срок', () => {
    expect(noteArchiveAfter(new Date('2024-09-24T10:00:00Z'), 'performance', false).toISOString()).toBe('2026-09-24T10:00:00.000Z')
  })
})

describe('§4 видимость однонаправленна только от shared_with_person', () => {
  it.each([
    ['shared_with_person', 'manager', true],
    ['shared_with_person', 'hr', true],
    ['shared_with_person', 'shared_with_person', false],
    ['manager', 'hr', false],
    ['hr', 'manager', false],
    ['hr', 'shared_with_person', false],
  ] as const)('%s → %s: сужение=%s', (from, to, narrowing) => {
    expect(isVisibilityNarrowing(from, to)).toBe(narrowing)
  })

  it('текст заметки — без пробелов по краям; 3–2000 знаков', () => {
    expect(normalizeNoteBody('  рядок\r\nдругий  ')).toBe('рядок\nдругий')
    expect(noteCreateSchema.safeParse({ body: '  ок  ' }).success).toBe(false)
    expect(noteCreateSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false)
    const ok = noteCreateSchema.parse({ body: '  Домовились про дедлайн  ' })
    expect(ok).toMatchObject({ body: 'Домовились про дедлайн', category: 'general', visibility: 'manager', isPinned: false, confirmSensitive: false })
    expect(noteUpdateSchema.safeParse({ confirmSensitive: true }).success).toBe(false) // «нічого не змінено»
  })
})

describe('даты документа', () => {
  it('календарная арифметика без поясов; 31.01 + 1 месяц = конец февраля', () => {
    expect(daysBetween('2026-09-24', '2026-10-24')).toBe(30)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // переход на летнее время не съедает день
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28')
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
  })

  it('§4 состояние по сроку: окно — наибольшее из remind_days, день истечения ещё действителен', () => {
    expect(documentStatusBy(null, '2026-09-24', [30, 7, 0])).toBe('valid')
    expect(documentStatusBy('2026-10-25', '2026-09-24', [30, 7, 0])).toBe('valid') // 31 день
    expect(documentStatusBy('2026-10-24', '2026-09-24', [30, 7, 0])).toBe('expiring') // 30 дней — §13 п. 8
    expect(documentStatusBy('2026-09-24', '2026-09-24', [30, 7, 0])).toBe('expiring')
    expect(documentStatusBy('2026-09-23', '2026-09-24', [30, 7, 0])).toBe('expired')
    expect(documentStatusBy('2026-10-04', '2026-09-24', [3, 14])).toBe('expiring')
  })

  it('§7.8 напоминания: в день перехода и в дни remind_days; после истечения — ещё 14 дней', () => {
    const rd = [30, 7, 0]
    expect(documentReminderDue('2026-10-24', '2026-09-24', rd, false)).toBe('expiring') // 30
    expect(documentReminderDue('2026-10-23', '2026-09-24', rd, false)).toBeNull() // 29
    expect(documentReminderDue('2026-10-23', '2026-09-24', rd, true)).toBe('expiring') // пропущенный переход
    expect(documentReminderDue('2026-10-01', '2026-09-24', rd, false)).toBe('expiring') // 7
    expect(documentReminderDue('2026-09-24', '2026-09-24', rd, false)).toBe('expiring') // 0
    expect(documentReminderDue('2026-09-23', '2026-09-24', rd, false)).toBe('expired')
    expect(documentReminderDue('2026-09-10', '2026-09-24', rd, false)).toBe('expired') // 14-й день
    expect(documentReminderDue('2026-09-09', '2026-09-24', rd, false)).toBeNull() // бесконечное напоминание игнорируется
  })

  it('§6.2 проверка дат: истёкший при загрузке — не ошибка (§12)', () => {
    const today = '2026-09-24'
    expect(validateDocumentDates({ issuedAt: '2026-09-25', expiresAt: null }, today, null)).toBe('issued_in_future')
    expect(validateDocumentDates({ issuedAt: '2026-09-01', expiresAt: '2026-09-01' }, today, null)).toBe('expires_before_issued')
    expect(validateDocumentDates({ issuedAt: '2026-09-01', expiresAt: null }, today, 12)).toBe('expires_required')
    expect(validateDocumentDates({ issuedAt: '2024-09-01', expiresAt: '2025-09-01' }, today, 12)).toBeNull()
  })

  it('§7.8 срок хранения файла — expires_at + 3 роки; бессрочный — без срока', () => {
    expect(documentRetentionUntil('2027-03-12')).toBe('2030-03-12')
    expect(documentRetentionUntil(null)).toBeNull()
  })
})

describe('документ: маска, замена, обязательность, файл', () => {
  it('§7.7 номер — последние 4 знака, ≤ 8 символов', () => {
    expect(maskDocumentNumber('МК 00123456')).toBe('****3456')
    expect(maskDocumentNumber('  ')).toBeNull()
    expect(maskDocumentNumber(null)).toBeNull()
    expect(maskDocumentNumber('12')!.length).toBeLessThanOrEqual(8)
  })

  it('§4 один действующий — у типа-«состояния»; более свежий по дате выдачи побеждает', () => {
    expect(documentTypeIsSingular({ isRequired: true, validityMonths: null })).toBe(true)
    expect(documentTypeIsSingular({ isRequired: false, validityMonths: 120 })).toBe(true)
    expect(documentTypeIsSingular({ isRequired: false, validityMonths: null })).toBe(false) // сертификаты копятся
    expect(newerDocumentWins('2026-01-10', '2026-09-01')).toBe('incoming')
    expect(newerDocumentWins('2026-09-01', '2026-01-10')).toBe('existing') // историческая запись
    expect(newerDocumentWins(null, '2026-01-10')).toBe('incoming')
  })

  it('§7.8 обязательность по посадам: пусто — для всех; выключенный тип не обязателен', () => {
    const t = { isRequired: true, isActive: true, requiredPositions: [] as string[] }
    expect(documentRequiredFor(t, ['p1'])).toBe(true)
    expect(documentRequiredFor({ ...t, requiredPositions: ['p2'] }, ['p1'])).toBe(false)
    expect(documentRequiredFor({ ...t, requiredPositions: ['p2'] }, ['p1', 'p2'])).toBe(true) // совместитель
    expect(documentRequiredFor({ ...t, isActive: false }, ['p1'])).toBe(false)
    expect(documentRequiredFor({ ...t, isRequired: false }, ['p1'])).toBe(false)
  })

  it('§6.2 файл: PDF, JPG, PNG до 20 МБ', () => {
    expect(documentFileAllowed('application/pdf', 20 * 1024 * 1024)).toBe(true)
    expect(documentFileAllowed('image/png', 20 * 1024 * 1024 + 1)).toBe(false)
    expect(documentFileAllowed('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1000)).toBe(false)
  })

  it('схемы: номер ≤ 32, дни напоминаний — без повторов по убыванию', () => {
    expect(documentCreateSchema.safeParse({ typeId: '7c4e6f55-8a64-4f7e-9c9f-0c7b3cf1f0a1', issuedAt: '2026-09-01', number: 'x'.repeat(33) }).success).toBe(false)
    expect(documentTypeCreateSchema.parse({ name: 'Посвідчення', remindDays: [7, 30, 0, 7] }).remindDays).toEqual([30, 7, 0])
    expect(documentTypeCreateSchema.safeParse({ name: 'Тип', code: 'Не латиниця' }).success).toBe(false)
  })
})

describe('§7.5 лексический скрин — мягкий, по основам слов', () => {
  it('ловит здоровье, беременность, судимость — на трёх языках', () => {
    expect(screenNoteText('Хворів два тижні, переносимо дедлайн').signs).toEqual(['health'])
    expect(screenNoteText('Вагітність, декрет з березня').signs).toEqual(['pregnancy'])
    expect(screenNoteText('Має судимість').signs).toEqual(['criminal'])
    expect(screenNoteText('Був у в’язниці').signs).toEqual(['criminal']) // апостроф внутри слова
    expect(screenNoteText('She mentioned her pregnancy').signs).toEqual(['pregnancy'])
    expect(screenNoteText('Беременна, уходит в декрет').signs).toEqual(['pregnancy'])
  })

  it('рабочий текст не трогает: «партія товару», «кредитна картка», «гейзер»', () => {
    expect(screenNoteText('Прийняв партію товару, розрахувався кредитною карткою').signs).toEqual([])
    expect(screenNoteText('Мийка-гейзер у барі потребує ремонту').signs).toEqual([])
    expect(screenNoteText('Домовились перенести атестацію на 12.03').signs).toEqual([])
  })

  it('короткие слова — только целиком; совпавшие слова — в flagged_terms', () => {
    expect(screenNoteText('Він гей').signs).toEqual(['orientation'])
    const r = screenNoteText('Хворів і має судимість')
    expect(r.signs).toEqual(['health', 'criminal'])
    expect(r.terms).toEqual(['хворів', 'судимість'])
  })
})
