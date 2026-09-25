import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_CONSENT_TEXT_VERSION, INTERVIEW_EVIDENCE_MAX, audioPurgeAfter, confidenceWord, consentDocument, isDisconnectGap,
  sessionConfidence, shingleSimilarity, turnFlags, validateScores, weightedScore,
} from '../../shared/domain/interview'
import { INTERVIEW_SCORE_PROMPT, INTERVIEW_TRANSCRIBE_PROMPT } from '../../server/services/ai/prompts'
import { interviewAnswerSchema, interviewConsentSchema, interviewScenarioCreateSchema } from '../../shared/schemas/interview'
import { ENUMS, QUIZ_KINDS } from '../../shared/enums'

/**
 * Правила ИИ-собеседования без базы (`docs/v2/30-ai-interview.md` §3.5, §5.1, §7.2, §7.7,
 * §7.11, §7.12, §7.17; план `45` PR-28): текст согласия, уверенность словом, итог и уверенность
 * сессии, проверка вывода модели (балл без обоснования и цитаты не проходит), сроки аудио,
 * обрыв связи, флаги для человека, промпты-заглушки.
 */

describe('вид теста и перечни (44 В-12)', () => {
  it('собеседование — третье значение вида теста, отдельной колонки `mode` нет', () => {
    expect([...QUIZ_KINDS]).toEqual(['quiz', 'certification', 'interview'])
    expect(ENUMS.quiz_kind).toBe(QUIZ_KINDS)
    expect(ENUMS.interview_degraded_reason).toContain('unexplained')
  })
})

describe('текст согласия (30 §5.1, §7.4)', () => {
  it('шесть строк экрана на языке человека, срок текста — дата согласия на ПД', () => {
    const uk = consentDocument('uk', { voice: true, audioDays: 90, textUntil: '2027-03-01' })
    expect(uk.title).toBe('Електронна співбесіда')
    expect(uk.lines).toHaveLength(6)
    expect(uk.lines[0]).toBe('Співбесіду проводить програма, а не людина.')
    expect(uk.lines[3]).toMatch(/Аудіо зберігається 90 днів, текст — до 1 березня 2027/)
    expect(uk.lines[4]).toMatch(/нікого не відхиляє/)
    expect(uk.lines[5]).toMatch(/не закриває для вас відбір/)
    expect(uk.full.slice(1, 7)).toEqual(uk.lines)
    expect(uk.full.length).toBeGreaterThan(uk.lines.length + 1)
  })

  it('без записи голоса — строки про аудио другие; английский и русский — свои тексты', () => {
    const text = consentDocument('uk', { voice: false, audioDays: 90, textUntil: null })
    expect(text.lines.join(' ')).not.toMatch(/Аудіо/)
    expect(text.lines[3]).toMatch(/до знеособлення ваших даних/)
    expect(consentDocument('en', { voice: true, audioDays: 90, textUntil: null }).lines[0]).toBe('The interview is conducted by a program, not a person.')
    expect(consentDocument('ru', { voice: true, audioDays: 90, textUntil: null }).lines[3]).toMatch(/90 дней/)
    expect(INTERVIEW_CONSENT_TEXT_VERSION).toMatch(/^interview-consent-v\d+$/)
  })
})

describe('уверенность и итог сессии (30 §7.2 в, §7.11)', () => {
  it('уверенность словом: ≥0.8 висока, 0.6–0.8 середня, <0.6 низька', () => {
    expect(confidenceWord(0.8)).toBe('high')
    expect(confidenceWord(0.79)).toBe('medium')
    expect(confidenceWord(0.6)).toBe('medium')
    expect(confidenceWord(0.59)).toBe('low')
    expect(confidenceWord(null)).toBeNull()
  })

  it('итог — взвешенное среднее долей шкалы к 100, уверенность — минимум, не среднее', () => {
    expect(weightedScore([{ value: 0.6, scaleMax: 5, weight: 1 }, { value: 0.6, scaleMax: 5, weight: 1 }])).toBe(12)
    expect(weightedScore([{ value: 5, scaleMax: 5, weight: 3 }, { value: 0, scaleMax: 10, weight: 1 }])).toBe(75)
    expect(weightedScore([])).toBeNull()
    expect(sessionConfidence([0.9, 0.55, 0.8])).toBe(0.55)
  })
})

describe('проверка вывода модели: балл без обоснования и цитаты не проходит (30 §3.5, §7.2)', () => {
  const criteria = [{ id: 'c1', name: 'Комунікація', scaleMax: 5 }, { id: 'c2', name: 'Досвід', scaleMax: 5 }]
  const turns = [
    { turnId: 't1', ordinal: 1, answer: 'Я працював баристою два роки у кавʼярні біля вокзалу.' },
    { turnId: 't2', ordinal: 2, answer: 'Спокійно пояснюю гостю, що сталося, і пропоную заміну.' },
  ]
  const good = [
    { criterionId: 'c1', value: 4, confidence: 0.8, rationale: 'Кандидат описує спокійне пояснення гостю.', evidence: [{ turnId: 't2', quote: 'Спокійно пояснюю гостю' }] },
    { criterionId: 'c2', value: 3.5, confidence: 0.7, rationale: 'Два роки досвіду баристою в кавʼярні.', evidence: [{ turnId: 't1', quote: 'працював баристою два роки' }] },
  ]

  it('у каждого критерия балл, обоснование и дословная цитата — проходит, цитата с позицией в ответе', () => {
    const r = validateScores(criteria, turns, good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scores[0]!.evidence[0]).toMatchObject({ turnId: 't2', ordinal: 2, quote: 'Спокійно пояснюю гостю', charFrom: 0, charTo: 22 })
    expect(r.scores[1]!.evidence[0]!.charFrom).toBe(2)
  })

  it('балл без цитаты, с выдуманной цитатой или без обоснования — не проходит', () => {
    const noEvidence = validateScores(criteria, turns, [good[0]!, { ...good[1]!, evidence: [] }])
    expect(noEvidence).toMatchObject({ ok: false })
    expect(!noEvidence.ok && noEvidence.problems).toContainEqual({ criterionId: 'c2', problem: 'evidence_missing' })

    const invented = validateScores(criteria, turns, [good[0]!, { ...good[1]!, evidence: [{ turnId: 't1', quote: 'керував рестораном' }] }])
    expect(!invented.ok && invented.problems.map(p => p.problem)).toEqual(expect.arrayContaining(['quote_not_found', 'evidence_missing']))

    const noRationale = validateScores(criteria, turns, [{ ...good[0]!, rationale: 'коротко' }, good[1]!])
    expect(!noRationale.ok && noRationale.problems).toContainEqual({ criterionId: 'c1', problem: 'rationale_missing' })
  })

  it('пропущенный критерий, чужая реплика и балл вне шкалы — тоже отказ', () => {
    expect(validateScores(criteria, turns, [good[0]!])).toMatchObject({ ok: false, problems: [{ criterionId: 'c2', problem: 'criterion_missing' }] })
    const foreign = validateScores(criteria, turns, [good[0]!, { ...good[1]!, evidence: [{ turnId: 'tX', quote: 'баристою' }] }])
    expect(!foreign.ok && foreign.problems.map(p => p.problem)).toContain('turn_unknown')
    expect(validateScores(criteria, turns, [{ ...good[0]!, value: 7 }, good[1]!])).toMatchObject({ ok: false })
  })

  it('цитат не больше трёх; регистр в цитате не важен, в ответ уходит текст из слов человека', () => {
    const many = Array.from({ length: 5 }, () => ({ turnId: 't1', quote: 'БАРИСТОЮ' }))
    const r = validateScores(criteria, turns, [good[0]!, { ...good[1]!, evidence: many }])
    expect(r.ok && r.scores[1]!.evidence).toHaveLength(INTERVIEW_EVIDENCE_MAX)
    expect(r.ok && r.scores[1]!.evidence[0]!.quote).toBe('баристою')
  })
})

describe('сроки и связь (30 §7.7, §7.12)', () => {
  it('аудио — 90 дней от конца, но не дольше согласия на ПД', () => {
    const end = new Date('2026-09-25T10:00:00Z')
    expect(audioPurgeAfter(end, null).toISOString().slice(0, 10)).toBe('2026-12-24')
    expect(audioPurgeAfter(end, '2026-10-10').toISOString().slice(0, 10)).toBe('2026-10-10')
    expect(audioPurgeAfter(end, '2027-10-10').toISOString().slice(0, 10)).toBe('2026-12-24')
  })

  it('обрыв — молчание канала дольше 30 секунд', () => {
    const now = new Date('2026-09-25T10:00:00Z')
    expect(isDisconnectGap(new Date(now.getTime() - 20 * 60_000), now)).toBe(true)
    expect(isDisconnectGap(new Date(now.getTime() - 10_000), now)).toBe(false)
    expect(isDisconnectGap(null, now)).toBe(false)
  })
})

describe('факты для человека (30 §7.17)', () => {
  it('ответ, зачитанный с вопроса, слишком быстрый длинный ответ и другой язык — флаги', () => {
    const prompt = 'Розкажіть, як ви поведетеся, якщо гість незадоволений замовленням і просить покликати керівника зміни'
    expect(shingleSimilarity(prompt, prompt)).toBe(1)
    expect(turnFlags({ answer: prompt, prompt, firstSoundDelayMs: 3000, lang: 'uk' }, 'uk')).toEqual(['read_aloud'])
    expect(turnFlags({ answer: 'а'.repeat(201), prompt: null, firstSoundDelayMs: 800, lang: 'en' }, 'uk')).toEqual(['too_fast', 'lang_mismatch'])
    expect(turnFlags({ answer: 'Коротко', prompt, firstSoundDelayMs: 500, lang: 'uk' }, 'uk')).toEqual([])
  })
})

describe('промпты собеседования (30 §7.10, §7.11)', () => {
  it('заглушка оценки: у каждого критерия обоснование и цитата из ответа — и проверку она проходит', () => {
    const input = {
      lang: 'uk' as const, strict: false,
      criteria: [{ id: 'c1', name: 'Комунікація', description: 'Ясно і спокійно пояснює', scaleMax: 5 }, { id: 'c2', name: 'Досвід', description: 'Досвід роботи з гостями', scaleMax: 10 }],
      turns: [{ turnId: 't1', ordinal: 1, question: 'Досвід?', answer: 'Два роки працював баристою і старшим зміни у кавʼярні в центрі міста, де багато гостей.' }],
    }
    const out = INTERVIEW_SCORE_PROMPT.stub(input)
    expect(out.criteria).toHaveLength(2)
    const r = validateScores(input.criteria, input.turns, out.criteria)
    expect(r.ok).toBe(true)
    expect(INTERVIEW_SCORE_PROMPT.stub(input)).toEqual(out)
    expect(INTERVIEW_SCORE_PROMPT.storeInput).toBe(true)
  })

  it('заглушка без ответов не выдумывает цитат — такой балл проверку не пройдёт', () => {
    const out = INTERVIEW_SCORE_PROMPT.stub({ lang: 'uk', strict: false, criteria: [{ id: 'c1', name: 'К', description: 'Опис критерію двадцять', scaleMax: 5 }], turns: [] })
    expect(out.criteria[0]!.evidence).toEqual([])
  })

  it('разбор ответа модели мягкий по цитатам (их проверяет сервис), но требует список критериев', () => {
    expect(INTERVIEW_SCORE_PROMPT.parse!({ criteria: [{ criterionId: 'c1', value: 3 }] })).toEqual({ criteria: [{ criterionId: 'c1', value: 3, confidence: null, rationale: null, evidence: [] }] })
    expect(() => INTERVIEW_SCORE_PROMPT.parse!({ criteria: [] })).toThrow()
    expect(INTERVIEW_SCORE_PROMPT.chat!({ lang: 'uk', strict: true, criteria: [], turns: [] })[0]!.content).toMatch(/Never recommend hiring or rejecting/)
  })

  it('расшифровка: Whisper verbose_json и простой ответ; вход журнала — ссылка на аудио, а не копия', () => {
    expect(INTERVIEW_TRANSCRIBE_PROMPT.parse!({ text: ' Привіт ', language: 'ukrainian', segments: [{ avg_logprob: Math.log(0.9) }, { avg_logprob: Math.log(0.7) }] }))
      .toEqual({ text: 'Привіт', language: 'uk', confidence: 0.8 })
    expect(INTERVIEW_TRANSCRIBE_PROMPT.parse!({ text: 'Hi', language: 'en', confidence: 0.4 })).toEqual({ text: 'Hi', language: 'en', confidence: 0.4 })
    const input = { mediaId: 'm', audioKey: 't/x/a.webm', mime: 'audio/webm', lang: 'uk' as const, durationMs: 4200 }
    expect(INTERVIEW_TRANSCRIBE_PROMPT.inputRef!(input)).toBe('t/x/a.webm')
    expect(INTERVIEW_TRANSCRIBE_PROMPT.stub(input).text).toMatch(/заглушки/)
  })
})

describe('контракты (30 §6.1, §10)', () => {
  it('сценарий: хотя бы один формат ответа, видео выключено, альтернатива может быть пуста в черновике', () => {
    const base = { quizId: '00000000-0000-4000-8000-000000000001', name: 'Бариста', introText: 'В'.repeat(60), outroText: 'Дякуємо за відповіді!!' }
    expect(interviewScenarioCreateSchema.safeParse(base).success).toBe(true)
    expect(interviewScenarioCreateSchema.safeParse({ ...base, answerModes: [] }).success).toBe(false)
    expect(interviewScenarioCreateSchema.safeParse({ ...base, recordVideo: true }).success).toBe(false)
    expect(interviewScenarioCreateSchema.safeParse({ ...base, minAnswerSec: 200, maxAnswerSec: 100 }).success).toBe(false)
  })

  it('ответ: голос с записью, текст до 5000 знаков, молчание', () => {
    expect(interviewAnswerSchema.safeParse({ mode: 'voice', mediaId: '00000000-0000-4000-8000-000000000001', durationMs: 1000 }).success).toBe(true)
    expect(interviewAnswerSchema.safeParse({ mode: 'text', text: 'x'.repeat(5001) }).success).toBe(false)
    expect(interviewAnswerSchema.safeParse({ mode: 'none' }).success).toBe(true)
    expect(interviewConsentSchema.safeParse({ decision: 'accepted', textVersion: 'v', textHash: 'nothex' }).success).toBe(false)
  })
})
