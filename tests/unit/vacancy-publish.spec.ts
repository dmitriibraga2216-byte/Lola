import { describe, expect, it } from 'vitest'
import { JOB_BOARD_ADAPTERS, REVOKED_STUB_SECRET, adapterFor, payloadHash } from '../../server/services/jobBoardAdapter'
import type { JobBoardPublishPayload } from '../../server/services/jobBoardAdapter'
import { STUB_AI_PROVIDER } from '../../server/services/vacancyAi'
import {
  JOB_BOARD_PROVIDERS, VACANCY_AI_CRITERIA_MAX, VACANCY_AI_CRITERIA_MIN, VACANCY_AI_TEXT_MAX_CHARS,
  VACANCY_PUBLICATION_STATES, VACANCY_PUBLISH_RETRY_DELAYS_SEC,
} from '../../shared/enums'

/**
 * Правила публикации и генерации текста, проверяемые без БД (docs/v2/29-vacancies.md §7.10,
 * §7.11, §7.15, §7.16, §7.18). Всё, чей смысл — в состоянии базы (аккаунты, публикации, RLS,
 * лимит `ai_generate_ops`), живёт в `tests/integration/v2-vacancy-publish.spec.ts`.
 */

const payload = (over: Partial<JobBoardPublishPayload> = {}): JobBoardPublishPayload => ({
  title: 'v2-17 Бариста',
  descriptionHtml: '<p>Опис</p>',
  requirementsHtml: null,
  dutiesHtml: null,
  extraHtml: null,
  city: 'Київ',
  countryCode: 'UA',
  employmentType: 'full_time',
  workFormat: 'on_site',
  experienceLevel: 'none',
  educationLevel: 'none',
  salaryFrom: null,
  salaryTo: null,
  salaryCurrency: 'UAH',
  salaryVisible: false,
  languages: [],
  applyUrl: 'https://lola.example/j/token123',
  ...over,
})

describe('перечень площадок и адаптер-заглушка (§3.7, §7.18)', () => {
  it('на каждую площадку из перечня есть адаптер', () => {
    for (const p of JOB_BOARD_PROVIDERS) {
      expect(JOB_BOARD_ADAPTERS[p]).toBeDefined()
      expect(adapterFor(p).isConfigured()).toBe(true)
    }
  })

  it('заглушка не делает сетевого вызова — connect() детерминирован и мгновенен', async () => {
    const r = await adapterFor('work_ua').connect()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.secret).toMatch(/^stub:work_ua:/)
      expect(r.accountLabel.length).toBeGreaterThan(0)
    }
  })

  it('успешная публикация отдаёт стабильный externalId по тому же payload', async () => {
    const a = adapterFor('robota_ua')
    const r1 = await a.publish('stub:secret-1', payload())
    const r2 = await a.publish('stub:secret-1', payload())
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok && r2.ok) expect(r1.externalId).toBe(r2.externalId)
  })

  it('отозванный секрет (§7.15) даёт revoked, а не обычную ошибку', async () => {
    const a = adapterFor('telegram')
    const r = await a.publish(REVOKED_STUB_SECRET, payload())
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.revoked).toBe(true); expect(r.retryable).toBe(false) }
    const h = await a.health(REVOKED_STUB_SECRET)
    expect(h.ok).toBe(false)
    if (!h.ok) expect(h.revoked).toBe(true)
  })

  it('здоровый секрет проходит health()', async () => {
    const h = await adapterFor('work_ua').health('stub:secret-ok')
    expect(h.ok).toBe(true)
  })

  it('маркер __JOBBOARD_FAIL__ в заголовке — временная ошибка, для теста ретраев §7.16', async () => {
    const r = await adapterFor('work_ua').publish('stub:secret-1', payload({ title: '__JOBBOARD_FAIL__' }))
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.retryable).toBe(true); expect(r.revoked).toBeUndefined() }
  })

  it('payloadHash детерминирован и различает разные payload', () => {
    const p1 = payload()
    const p2 = payload({ city: 'Львів' })
    expect(payloadHash(p1)).toBe(payloadHash(payload()))
    expect(payloadHash(p1)).not.toBe(payloadHash(p2))
  })
})

describe('состояния публикации (§3.8, пометка-исправление PR-17)', () => {
  it('восьмое значение manual — обходной путь `44` §8', () => {
    expect(VACANCY_PUBLICATION_STATES).toContain('manual')
    expect(VACANCY_PUBLICATION_STATES).toHaveLength(8)
  })

  it('три ретрая — 1, 5, 25 минут (§7.16)', () => {
    expect(VACANCY_PUBLISH_RETRY_DELAYS_SEC).toEqual([60, 300, 1500])
  })
})

describe('провайдер-заглушка генерации текста (§7.10, §7.11)', () => {
  it('текст блока не длиннее лимита символов', async () => {
    const r = await STUB_AI_PROVIDER.generateText({
      target: 'description', tone: null, title: 'v2-17 Бариста', city: 'Київ', employmentType: 'full_time',
      workFormat: 'on_site', experienceLevel: 'none', educationLevel: 'none',
      siblingBlocks: {}, language: 'uk',
    })
    expect(r.html.length).toBeLessThanOrEqual(VACANCY_AI_TEXT_MAX_CHARS)
    expect(r.html).toContain('Бариста')
  })

  it('черновик критериев — от 3 до 8 строк, без сохранения (§7.11)', async () => {
    const r = await STUB_AI_PROVIDER.generateCriteria({
      title: 'v2-17 Бариста', city: 'Київ', employmentType: 'full_time',
      requirementsHtml: '<p>Досвід у кав\'ярні</p>', dutiesHtml: null, language: 'uk',
    })
    expect(r.criteria.length).toBeGreaterThanOrEqual(VACANCY_AI_CRITERIA_MIN)
    expect(r.criteria.length).toBeLessThanOrEqual(VACANCY_AI_CRITERIA_MAX)
    for (const c of r.criteria) expect(c.weight).toBeGreaterThan(0)
  })

  it('генерация детерминирована: тот же вход даёт тот же текст', async () => {
    const input = {
      target: 'requirements' as const, tone: null, title: 'v2-17 Офіціант', city: null, employmentType: null,
      workFormat: null, experienceLevel: null, educationLevel: null, siblingBlocks: {}, language: 'uk' as const,
    }
    const a = await STUB_AI_PROVIDER.generateText(input)
    const b = await STUB_AI_PROVIDER.generateText(input)
    expect(a.html).toBe(b.html)
  })
})
